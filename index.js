import {
    Client,
    GatewayIntentBits,
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags
} from 'discord.js';
import http from 'http';

// ---------------------------------------------------------------------------
// Configuration (all optional values can be set as Render environment variables)
// ---------------------------------------------------------------------------
// Required: DISCORD_TOKEN, GEMINI_API_KEY
// Optional: GEMINI_MODEL        (default: gemini-flash-latest, always points to the newest Flash model)
//           USE_SEARCH          (default: true, lets Gemini use Google Search for live/current info)
//           AI_CHANNEL_ID       (one or more channel IDs separated by commas, active after every restart)
//           PORT                (Render sets this automatically)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const USE_SEARCH = (process.env.USE_SEARCH ?? 'true').toLowerCase() !== 'false';

// Model names change often. Aliases like "-latest" avoid your bot breaking when old models are retired.
const MODEL_CHAIN = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-flash-latest',
    'gemini-flash-lite-latest'
])];

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_HISTORY_MESSAGES = 12;          // short memory per channel (user + bot messages)
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const REQUEST_TIMEOUT_MS = 60_000;
const DISCORD_CHUNK_SIZE = 1900;          // Discord's hard limit is 2000 characters

if (!DISCORD_TOKEN || !GEMINI_API_KEY) {
    console.error('Missing DISCORD_TOKEN or GEMINI_API_KEY environment variable. Add them in Render > Environment.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------
// Note: "Message Content Intent" must also be switched ON in the Discord Developer Portal > Bot.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Active AI channels (kept in memory; use the AI_CHANNEL_ID env variable to survive restarts)
const activeChannels = new Set(
    (process.env.AI_CHANNEL_ID || '').split(',').map(id => id.trim()).filter(Boolean)
);

// Short conversation memory per channel
const channelHistory = new Map();

// ---------------------------------------------------------------------------
// Tiny web server so Render sees an open port
// ---------------------------------------------------------------------------
const webServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Duro AI is active and running 24/7\n');
});
const serverPort = process.env.PORT || 10000;
webServer.listen(serverPort, '0.0.0.0', () => {
    console.log(`Health check server listening on port ${serverPort}`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const getCurrentDateTimeString = () =>
    new Date().toLocaleString('en-US', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'UTC'
    }) + ' UTC';

const buildSystemInstruction = () =>
    `You are Duro, a helpful AI assistant for the ChaosBoys Discord server. ` +
    `Keep your answers brief, simple, and direct. Use plain Discord-friendly formatting. ` +
    `Messages from users are prefixed with their display name. ` +
    `The current date and time is ${getCurrentDateTimeString()}. ` +
    `For anything that may have changed recently (news, subscriber counts, prices, scores, releases), ` +
    `rely on search results when available instead of memory, and say if you are unsure.`;

class GeminiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'GeminiError';
        this.status = status;
    }
}

// Split long text into Discord-sized pieces, preferring line/word boundaries
function splitMessage(text, max = DISCORD_CHUNK_SIZE) {
    const chunks = [];
    let rest = text.trim();
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

// Download image attachments and convert them to Gemini "inlineData" parts
async function buildImageParts(message) {
    const images = [...message.attachments.values()]
        .filter(a => a.contentType?.startsWith('image/') && a.size <= MAX_IMAGE_BYTES)
        .slice(0, MAX_IMAGES_PER_MESSAGE);

    const parts = [];
    for (const image of images) {
        try {
            const res = await fetch(image.url, { signal: AbortSignal.timeout(20_000) });
            if (!res.ok) continue;
            const buffer = Buffer.from(await res.arrayBuffer());
            parts.push({
                inlineData: {
                    mimeType: image.contentType.split(';')[0],
                    data: buffer.toString('base64')
                }
            });
        } catch (err) {
            console.warn(`Could not download attachment ${image.name}:`, err.message);
        }
    }
    return parts;
}

// One request to the Gemini API for a specific model
async function requestGemini(model, contents, withSearch) {
    const body = {
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
        contents,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
        }
    };
    if (withSearch) body.tools = [{ googleSearch: {} }];

    const response = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY // key in a header, not in the URL, so it never leaks into logs
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const raw = await response.text();
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new GeminiError(`Non-JSON response (HTTP ${response.status}): ${raw.slice(0, 200)}`, response.status);
    }

    if (!response.ok) {
        const msg = data?.error?.message || `HTTP ${response.status}`;
        throw new GeminiError(msg, response.status);
    }
    return data;
}

// Tries search first, then no search, then the fallback model
async function askGemini(contents) {
    let lastError;

    for (const model of MODEL_CHAIN) {
        const attempts = USE_SEARCH ? [true, false] : [false];

        for (const withSearch of attempts) {
            try {
                const data = await requestGemini(model, contents, withSearch);

                if (data.promptFeedback?.blockReason) {
                    return "⚠️ I can't answer that one (it was blocked by safety filters).";
                }

                const candidate = data.candidates?.[0];
                const text = (candidate?.content?.parts || [])
                    .filter(part => part.text && !part.thought) // skip internal "thinking" parts
                    .map(part => part.text)
                    .join('')
                    .trim();

                if (text) return text;

                if (candidate?.finishReason === 'SAFETY') {
                    return "⚠️ I can't answer that one (it was blocked by safety filters).";
                }
                lastError = new GeminiError(`Empty response (finishReason: ${candidate?.finishReason})`, 200);
            } catch (err) {
                lastError = err;
                console.error(`Gemini error [model=${model}, search=${withSearch}]:`, err.message);

                // Rate limit or bad key will not be fixed by retrying with another model
                // (a 403 while search is on may just mean search isn't allowed, so that one retries without search first)
                if (err.status === 429 || err.status === 401 || (err.status === 403 && !withSearch)) throw err;
                // Otherwise: retry without search, then with the next model
            }
        }
    }
    throw lastError ?? new GeminiError('Unknown Gemini failure');
}

function friendlyErrorMessage(err) {
    if (err instanceof GeminiError) {
        if (err.status === 429) return '⏳ I\'m getting too many requests right now. Please try again in a minute.';
        if (err.status === 401 || err.status === 403) return '🔑 My Gemini API key was rejected. The server owner needs to check it.';
        if (err.status === 404) return '🛠️ The AI model I\'m set to use is no longer available. The server owner needs to update GEMINI_MODEL.';
    }
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return '⌛ That took too long. Please try again.';
    return '⚠️ Something went wrong while thinking about that. Please try again.';
}

function addToHistory(channelId, role, text) {
    const history = channelHistory.get(channelId) ?? [];
    history.push({ role, parts: [{ text }] });
    while (history.length > MAX_HISTORY_MESSAGES) history.shift();
    channelHistory.set(channelId, history);
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
client.once(Events.ClientReady, async () => {
    console.log(`Duro AI is online as ${client.user.tag}! Models: ${MODEL_CHAIN.join(' -> ')}`);

    const slashCommands = [
        new SlashCommandBuilder()
            .setName('set-ai-channel')
            .setDescription('Set the current channel as an active AI conversation room.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('remove-ai-channel')
            .setDescription('Remove the AI chatbot from the current channel.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('reset-ai-memory')
            .setDescription('Make Duro forget the recent conversation in this channel.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        console.log('Refreshing application (/) commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: 'Please use this command inside a server channel.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
            await interaction.reply({ content: '🚫 You need the **Manage Channels** permission to use this command.', flags: MessageFlags.Ephemeral });
            return;
        }

        const channelId = interaction.channelId;

        switch (interaction.commandName) {
            case 'set-ai-channel':
                activeChannels.add(channelId);
                await interaction.reply('🤖 **Duro AI Channel Locked!** I will now answer every message sent in this channel.');
                break;

            case 'remove-ai-channel':
                if (activeChannels.delete(channelId)) {
                    channelHistory.delete(channelId);
                    await interaction.reply('❌ **Duro AI Removed!** I will no longer respond to messages in this channel.');
                } else {
                    await interaction.reply({ content: '⚠️ This channel is not currently an active Duro AI channel.', flags: MessageFlags.Ephemeral });
                }
                break;

            case 'reset-ai-memory':
                channelHistory.delete(channelId);
                await interaction.reply('🧹 Memory cleared for this channel.');
                break;
        }
    } catch (error) {
        console.error('Interaction error:', error);
    }
});

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild() || !activeChannels.has(message.channel.id)) return;

    const hasImages = [...message.attachments.values()].some(a => a.contentType?.startsWith('image/'));
    if (!message.content.trim() && !hasImages) return;

    // Discord's typing indicator lasts ~10 seconds, so refresh it while waiting for the AI
    message.channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

    try {
        const author = message.member?.displayName || message.author.username;
        const userText = message.content.trim() || '(image only)';
        const promptText = `${author}: ${userText}`;

        const imageParts = await buildImageParts(message);
        const history = channelHistory.get(message.channel.id) ?? [];

        const contents = [
            ...history,
            { role: 'user', parts: [{ text: promptText }, ...imageParts] }
        ];

        const answer = await askGemini(contents);

        // Only remember the exchange if it worked
        addToHistory(message.channel.id, 'user', imageParts.length ? `${promptText} [attached ${imageParts.length} image(s)]` : promptText);
        addToHistory(message.channel.id, 'model', answer);

        const chunks = splitMessage(answer);
        // allowedMentions stops the AI from pinging @everyone / roles / users by accident
        const safeMentions = { parse: [], repliedUser: false };

        await message.reply({ content: chunks[0], allowedMentions: safeMentions });
        for (const chunk of chunks.slice(1)) {
            await message.channel.send({ content: chunk, allowedMentions: safeMentions });
        }
    } catch (error) {
        console.error('Message handling error:', error);
        await message.reply({ content: friendlyErrorMessage(error), allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    } finally {
        clearInterval(typingInterval);
    }
});

// ---------------------------------------------------------------------------
// Stability: log problems instead of crashing, shut down cleanly on redeploys
// ---------------------------------------------------------------------------
client.on(Events.Error, error => console.error('Discord client error:', error));
process.on('unhandledRejection', reason => console.error('Unhandled rejection:', reason));

const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down...`);
    webServer.close();
    await client.destroy();
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

client.login(DISCORD_TOKEN);
