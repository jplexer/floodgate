import { Elysia, t } from 'elysia';
import { config } from 'dotenv';
import fs from 'node:fs/promises'; // For reading the HTML file
import path from 'node:path'; // For path joining

config(); // Load environment variables from .env file

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const REQUIRED_SERVER_ID = process.env.REQUIRED_SERVER_ID;
// Expect comma-separated string for role IDs: e.g., "role1,role2,role3"
const REQUIRED_ROLE_IDS_STRING = process.env.REQUIRED_ROLE_IDS;
const COMMAND_TO_RUN = process.env.COMMAND_TO_RUN;

let htmlTemplate = '';

// Helper function to render HTML
async function renderHtml(title: string, messageContent: string) {
    if (!htmlTemplate) {
        try {
            const templatePath = path.join(import.meta.dir, 'index.html');
            htmlTemplate = await fs.readFile(templatePath, 'utf-8');
        } catch (e) {
            console.error("Error reading HTML template:", e);
            return "Error loading page template. Please check server logs."; // Fallback
        }
    }
    return htmlTemplate
        .replace('{{TITLE}}', title)
        .replace('{{{MESSAGE_CONTENT}}}', messageContent);
}

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !REQUIRED_SERVER_ID || !REQUIRED_ROLE_IDS_STRING || !COMMAND_TO_RUN) {
    console.error("Missing one or more required environment variables. Please check your .env file (ensure REQUIRED_ROLE_IDS is set).");
    process.exit(1);
}

const REQUIRED_ROLE_IDS = REQUIRED_ROLE_IDS_STRING.split(',').map(id => id.trim()).filter(id => id);

if (REQUIRED_ROLE_IDS.length === 0) {
    console.error("REQUIRED_ROLE_IDS environment variable is empty or invalid. Please provide a comma-separated list of role IDs.");
    process.exit(1);
}

const app = new Elysia()
    .decorate('render', renderHtml)
    .get("/", async ({ render, set }) => {
        set.headers['Content-Type'] = 'text/html; charset=utf-8';
        return render(
            "Welcome to the Bits and Bytes PDS Invite generator",
            'Please <a href="/login" class="button">Login with Discord</a> to continue.'
        );
    })
    .get("/login", ({ redirect }) => {
        const params = new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            redirect_uri: DISCORD_REDIRECT_URI,
            response_type: 'code',
            scope: 'identify guilds guilds.members.read'
        });
        return redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
    })
    .get("/callback", async ({ query, set, render }) => {
        // Set Content-Type for all HTML responses from this handler
        set.headers['Content-Type'] = 'text/html; charset=utf-8';

        const code = query.code as string;

        if (!code) {
            set.status = 400;
            return render("Error", '<p class="error">No authorization code provided.</p>');
        }

        try {
            // 1. Exchange code for access token
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    client_id: DISCORD_CLIENT_ID,
                    client_secret: DISCORD_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: DISCORD_REDIRECT_URI,
                }),
            });

            if (!tokenResponse.ok) {
                const errorData = await tokenResponse.json();
                console.error("Discord token exchange error:", errorData);
                set.status = tokenResponse.status;
                return render("Login Error", `<p class="error">Error exchanging code: ${errorData.error_description || tokenResponse.statusText}</p>`);
            }

            const { access_token, token_type } = await tokenResponse.json() as { access_token: string, token_type: string };

            // 2. Fetch user's guilds (servers)
            const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
                headers: {
                    Authorization: `${token_type} ${access_token}`,
                },
            });

            if (!guildsResponse.ok) {
                const errorData = await guildsResponse.json();
                console.error("Discord guilds fetch error:", errorData);
                set.status = guildsResponse.status;
                return render("Error", '<p class="error">Error fetching user guilds.</p>');
            }

            const guilds = await guildsResponse.json() as { id: string, name: string }[];
            const isInServer = guilds.some(guild => guild.id === REQUIRED_SERVER_ID);

            if (!isInServer) {
                return render("Access Denied", `<p class="error">You are not a member of the required server (ID: ${REQUIRED_SERVER_ID}).</p>`);
            }

            // 3. Fetch user's roles in the specific server
            const memberResponse = await fetch(`https://discord.com/api/users/@me/guilds/${REQUIRED_SERVER_ID}/member`, {
                headers: {
                    Authorization: `${token_type} ${access_token}`,
                },
            });

            if (!memberResponse.ok) {
                 const errorData = await memberResponse.json();
                 console.error("Discord member fetch error:", errorData);
                 if (memberResponse.status === 403) {
                    return render("Permission Error", '<p class="error">Could not verify your roles in the server. This might be due to permissions. Ensure the \'guilds.members.read\' scope was granted and is effective.</p>');
                 }
                 set.status = memberResponse.status;
                 return render("Error", '<p class="error">Error fetching your member details from the server.</p>');
            }

            const member = await memberResponse.json() as { roles: string[] };
            const hasRequiredRole = REQUIRED_ROLE_IDS.some(roleId => member.roles.includes(roleId));

            if (!hasRequiredRole) {
                return render("Access Denied", `<p class="error">You do not have any of the required roles (IDs: ${REQUIRED_ROLE_IDS.join(', ')}) in the server.</p>`);
            }

            // 4. If all checks pass, run the command
            try {
                const { spawn } = await import('bun');
                const proc = spawn(COMMAND_TO_RUN.split(" ")); // Simple split, might need more robust parsing for complex commands
                const stdout = await new Response(proc.stdout).text();
                const stderr = await new Response(proc.stderr).text();

                if (stderr) {
                    console.error(`Error: ${stderr}`);
                    return render("Error", `Command executed with error: <pre>${stderr}</pre>`);
                }
                return render("Success!", `<p class="success">Here is your invite code:</p><pre>${stdout}</pre>`);
            } catch (e: any) {
                console.error("Error running command:", e);
                set.status = 500;
                return render("System Error", '<p class="error">Error running command on the system.</p>');
            }

        } catch (error) {
            console.error("Callback error:", error);
            set.status = 500;
            return render("System Error", '<p class="error">An unexpected error occurred.</p>');
        }
    })
    .onError(({ code, error, set, render }) => {
        console.error(`Unhandled error [${code}]:`, error);
        set.status = 500;
        set.headers['Content-Type'] = 'text/html; charset=utf-8'; // Set header for error responses
        return render("System Error", '<p class="error">A critical server error occurred.</p>');
    })
    .listen(3031);

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);