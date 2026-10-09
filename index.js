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

// Model chosen per channel with /duro-models (channels without a choice use the default MODEL_CHAIN)
const channelModels = new Map();

// Personal model chosen by each user with /my-duro-models (works in every AI channel, beats the channel model)
const userModels = new Map();

// Cached list of models your API key can use (refreshed every 10 minutes)
let modelListCache = { fetchedAt: 0, models: [] };

// Google Search has its own, much smaller quota. When it runs out, skip search for a while
// so every message doesn't waste time (and quota) on requests that are certain to fail.
const SEARCH_COOLDOWN_MS = 30 * 60 * 1000;
let searchBlockedUntil = 0;

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

// Only mention Google Search when the search tool is really attached to the request.
// (Telling a model to search when it has no search tool makes it fail with MALFORMED_FUNCTION_CALL.)
const buildSystemInstruction = (withSearch) =>
    `You are Duro, a helpful AI assistant for the ChaosBoys Discord server. ` +
    `Keep your answers brief, simple, and direct. Use plain Discord-friendly formatting. ` +
    `Messages from users are prefixed with their display name so you know who is talking, ` +
    `but NEVER start your own reply with a name or "Name:", just answer directly. ` +
    `The current date and time is ${getCurrentDateTimeString()}. ` +
    (withSearch
        ? `Use Google Search for questions about current facts, numbers, rankings, news, or anything that changes over time. `
        : `You cannot search the internet right now. For anything that may have changed recently ` +
          `(news, subscriber counts, prices, scores, releases), give your best knowledge and clearly say it may be outdated. `);

class GeminiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'GeminiError';
        this.status = status;
    }
}

// Ask Google which text models this API key can actually use
async function getAvailableModels() {
    const cacheIsFresh = Date.now() - modelListCache.fetchedAt < 10 * 60 * 1000;
    if (cacheIsFresh && modelListCache.models.length) return modelListCache.models;

    const models = [];
    let pageToken = '';

    do {
        const url = `${GEMINI_BASE_URL}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await fetch(url, {
            headers: { 'x-goog-api-key': GEMINI_API_KEY },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) throw new GeminiError(`ListModels failed (HTTP ${res.status})`, res.status);

        const data = await res.json();
        for (const m of data.models || []) {
            const id = m.name.replace(/^models\//, '');
            if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
            if (!id.startsWith('gemini')) continue;
            // Skip models that don't do normal text chat (image, voice, embeddings, live audio, etc.)
            if (/image|tts|embed|live|audio|robotics|computer-use|aqa/i.test(id)) continue;
            models.push({ id, displayName: m.displayName || id });
        }
        pageToken = data.nextPageToken || '';
    } while (pageToken);

    models.sort((a, b) => a.id.localeCompare(b.id));
    modelListCache = { fetchedAt: Date.now(), models };
    return models;
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
        systemInstruction: { parts: [{ text: buildSystemInstruction(withSearch) }] },
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
async function askGemini(contents, channelId, userId) {
    let lastError;

    // Priority: the user's personal model, then the channel model, then the default models as backups
    const modelsToTry = [...new Set([
        userModels.get(userId),
        channelModels.get(channelId),
        ...MODEL_CHAIN
    ].filter(Boolean))];

    for (const model of modelsToTry) {
        const searchAllowed = USE_SEARCH && Date.now() >= searchBlockedUntil;
        const attempts = searchAllowed ? [true, false] : [false];

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

                if (text) {
                    // Diagnostic: shows in Render logs whether Google Search was really used for this answer
                    console.log(`Answered with model=${model}, searchRequested=${withSearch}, grounded=${Boolean(candidate?.groundingMetadata)}`);
                    return text;
                }

                if (candidate?.finishReason === 'SAFETY') {
                    return "⚠️ I can't answer that one (it was blocked by safety filters).";
                }
                lastError = new GeminiError(`Empty response (finishReason: ${candidate?.finishReason})`, 200);
            } catch (err) {
                lastError = err;
                console.error(`Gemini error [model=${model}, search=${withSearch}]:`, err.message);

                // Search quota used up: stop asking for search for a while
                if (withSearch && err.status === 429) {
                    searchBlockedUntil = Date.now() + SEARCH_COOLDOWN_MS;
                    console.warn('Search quota reached, answering without Google Search for the next 30 minutes.');
                }
                // Google is overloaded (HTTP 500/503): short pause before trying the next option
                if (err.status === 500 || err.status === 503) await new Promise(resolve => setTimeout(resolve, 1500));

                // A rejected API key will not be fixed by retrying with another model
                // (a 403 while search is on may just mean search isn't allowed, so that one retries without search first)
                // A 429 (quota) is NOT fatal: search and each model have separate quotas, so keep trying the next option
                if (err.status === 401 || (err.status === 403 && !withSearch)) throw err;
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
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('duro-models')
            .setDescription('Admins only: set the default Gemini model for this channel.')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(option =>
                option
                    .setName('model')
                    .setDescription('Type to search the models your API key can use (leave empty to see the current one)')
                    .setAutocomplete(true)
            ),
        // No permission restriction here: every member can use it
        new SlashCommandBuilder()
            .setName('my-duro-models')
            .setDescription('Choose your own personal Gemini model for your messages to Duro.')
            .addStringOption(option =>
                option
                    .setName('model')
                    .setDescription('Type to search the models available (leave empty to see your current one)')
                    .setAutocomplete(true)
            )
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
    // The dropdown/search box for /duro-models: Discord asks for matching models while you type
    if (interaction.isAutocomplete()) {
        try {
            const typed = interaction.options.getFocused().toLowerCase();
            const models = await getAvailableModels();

            const defaultLabel = interaction.commandName === 'my-duro-models'
                ? "Default (use this channel's model)"
                : `Default (${MODEL_CHAIN[0]})`;

            const choices = [{ name: defaultLabel, value: 'default' }]
                .concat(models.map(m => ({ name: `${m.displayName} (${m.id})`.slice(0, 100), value: m.id })))
                .filter(choice => choice.name.toLowerCase().includes(typed) || choice.value.includes(typed))
                .slice(0, 25); // Discord allows at most 25 suggestions

            await interaction.respond(choices);
        } catch (error) {
            console.error('Autocomplete error:', error.message);
            await interaction.respond([]).catch(() => {});
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: 'Please use this command inside a server channel.', flags: MessageFlags.Ephemeral });
            return;
        }

        // Each command has its own required permission (my-duro-models is open to everyone)
        const requiredPermission = {
            'set-ai-channel': PermissionFlagsBits.ManageChannels,
            'remove-ai-channel': PermissionFlagsBits.ManageChannels,
            'reset-ai-memory': PermissionFlagsBits.ManageChannels,
            'duro-models': PermissionFlagsBits.Administrator
        }[interaction.commandName];

        if (requiredPermission && !interaction.memberPermissions?.has(requiredPermission)) {
            const who = requiredPermission === PermissionFlagsBits.Administrator ? '**Administrator**' : '**Manage Channels**';
            await interaction.reply({ content: `🚫 You need the ${who} permission to use this command.`, flags: MessageFlags.Ephemeral });
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

            case 'duro-models': {
                if (!activeChannels.has(channelId)) {
                    await interaction.reply({ content: '⚠️ Run `/set-ai-channel` in this channel first, then pick a model.', flags: MessageFlags.Ephemeral });
                    break;
                }

                const chosen = interaction.options.getString('model');
                const current = channelModels.get(channelId) || MODEL_CHAIN[0];

                // No option given: just show the current model
                if (!chosen) {
                    await interaction.reply({
                        content: `🧠 Current model for this channel: \`${current}\`\nUse \`/duro-models\` and pick from the list to change it.`,
                        flags: MessageFlags.Ephemeral
                    });
                    break;
                }

                if (chosen === 'default') {
                    channelModels.delete(channelId);
                    await interaction.reply(`🔄 This channel is back on the default model: \`${MODEL_CHAIN[0]}\`.`);
                    break;
                }

                await interaction.deferReply();

                // Make sure the typed name really exists on this API key
                let models = [];
                try {
                    models = await getAvailableModels();
                } catch (error) {
                    console.error('Could not verify model list:', error.message);
                }

                if (models.length && !models.some(m => m.id === chosen)) {
                    await interaction.editReply(`❌ \`${chosen}\` isn't available on my API key. Pick one from the suggestion list.`);
                    break;
                }

                channelModels.set(channelId, chosen);
                await interaction.editReply(`✅ This channel's default model is now \`${chosen}\`. Members who picked their own with \`/my-duro-models\` keep theirs. If a model fails or hits a quota, I'll fall back to the default models.`);
                break;
            }

            case 'my-duro-models': {
                const chosen = interaction.options.getString('model');
                const personal = userModels.get(interaction.user.id);
                const channelDefault = channelModels.get(channelId) || MODEL_CHAIN[0];

                // No option given: show which model is used for this person
                if (!chosen) {
                    await interaction.reply({
                        content: personal
                            ? `🧠 Your personal model: \`${personal}\`\nUse \`/my-duro-models\` and pick from the list to change it, or choose **Default** to go back to the channel's model.`
                            : `🧠 You have no personal model, so I use this channel's model: \`${channelDefault}\`\nUse \`/my-duro-models\` and pick from the list to choose your own.`,
                        flags: MessageFlags.Ephemeral
                    });
                    break;
                }

                if (chosen === 'default') {
                    userModels.delete(interaction.user.id);
                    await interaction.reply({ content: `🔄 Your personal model is removed. I'll use the channel's model: \`${channelDefault}\`.`, flags: MessageFlags.Ephemeral });
                    break;
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                let models = [];
                try {
                    models = await getAvailableModels();
                } catch (error) {
                    console.error('Could not verify model list:', error.message);
                }

                if (models.length && !models.some(m => m.id === chosen)) {
                    await interaction.editReply(`❌ \`${chosen}\` isn't available on my API key. Pick one from the suggestion list.`);
                    break;
                }

                userModels.set(interaction.user.id, chosen);
                await interaction.editReply(`✅ Your messages to Duro now use \`${chosen}\`, in every AI channel. If it fails or hits a quota, I'll fall back to the channel's model.`);
                break;
            }
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

        let answer = await askGemini(contents, message.channel.id, message.author.id);

        // Safety net: remove a leading "Name:" if the model still copies the prefix
        const prefix = `${author}:`;
        if (answer.startsWith(prefix)) answer = answer.slice(prefix.length).trim();

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
