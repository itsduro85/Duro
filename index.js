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
// Optional: GEMINI_MODEL        (default: gemini-flash-lite-latest, the fast and light model)
//           USE_SEARCH          (default: true, lets Gemini use Google Search for live/current info)
//           AI_CHANNEL_ID       (one or more channel IDs separated by commas, active after every restart)
//           TAVILY_API_KEY      (free key from tavily.com: lets Duro look things up on the internet)
//           WEB_SEARCH_ALWAYS   (default: false = only search when a question needs fresh info; true = search every message)
//           AUTOMOD             (default: true; set to false to switch off the automatic warnings and timeouts)
//           MOD_LOG_CHANNEL_ID  (optional: channel ID where Duro reports every warning/timeout for the mods)
//           PORT                (Render sets this automatically)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const USE_SEARCH = (process.env.USE_SEARCH ?? 'true').toLowerCase() !== 'false';

// Web search through Tavily (independent of Google's search quota)
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const WEB_SEARCH_ENABLED = Boolean(TAVILY_API_KEY);
const WEB_SEARCH_ALWAYS = (process.env.WEB_SEARCH_ALWAYS ?? 'false').toLowerCase() === 'true';
// Words that suggest the question needs fresh information from the internet
const FRESH_INFO_PATTERN = /\b(latest|newest|current|currently|today|tonight|now|recent|recently|news|update|updated|version|release|released|price|cost|how many|how much|score|weather|who is|who won|ranking|rank|trending|this (week|month|year)|20(2[4-9]|3\d))\b/i;

// Model names change often. Aliases like "-latest" avoid your bot breaking when old models are retired.
const MODEL_CHAIN = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-flash-lite-latest', // light and fast: best for chat replies
    'gemini-flash-latest'                                     // stronger backup if the first one fails
])];

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_HISTORY_MESSAGES = 12;          // short memory per channel (user + bot messages)
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const REQUEST_TIMEOUT_MS = 30_000;        // give up on a stuck model sooner and try the backup
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

// Small cooldown for /ask-duro so nobody burns the free quota by accident
const ASK_COOLDOWN_MS = 5000;
const askCooldowns = new Map();

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
const buildSystemInstruction = (withSearch, hasWebResults, model) =>
    `You are Duro, a helpful AI assistant for the ChaosBoys Discord server. ` +
    `Keep your answers brief, simple, and direct. Use plain Discord-friendly formatting. ` +
    `Messages from users are prefixed with their display name so you know who is talking, ` +
    `but NEVER start your own reply with a name or "Name:", just answer directly. ` +
    `Never mention where your information came from (no "according to...", no website, account or source names) ` +
    `unless the user explicitly asks for the source. ` +
    `The current date and time is ${getCurrentDateTimeString()}. ` +
    `You are running on Google's Gemini model "${model}" (this name can be an alias that always points to Google's newest version of that model family). ` +
    `If asked which model or AI you are, give exactly this name and never guess a different version number. ` +
    (withSearch
        ? `Use Google Search for questions about current facts, numbers, rankings, news, or anything that changes over time. `
        : hasWebResults
            ? `Fresh web search results were fetched just now and are included in the user's message. ` +
              `Use them to answer: they are more reliable and more recent than your own memory. ` +
              `If they contain the exact number or fact the user asked for, state it directly and precisely; ` +
              `do not tell the user to check other websites when the answer is in the results. ` +
              `Do not name the sources unless asked. If the results truly do not answer the question, say so honestly. `
            : WEB_SEARCH_ENABLED
                ? `You can look things up on the internet: a web search runs automatically when a question needs fresh information. ` +
                  `No search was needed for this message, so answer from your own knowledge. `
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

// Decide if a message looks like it needs fresh information from the internet
function needsWebSearch(text) {
    if (!WEB_SEARCH_ENABLED) return false;
    if (WEB_SEARCH_ALWAYS) return text.length >= 4;
    return FRESH_INFO_PATTERN.test(text);
}

// Look the question up with Tavily and return the results as text for Gemini (empty string = no results)
async function getWebResults(userText, history) {
    if (!needsWebSearch(userText)) return '';

    // Follow-ups like "and how many subscribers?" or "how many does he have?" don't say WHO or WHAT they are about,
    // so borrow the previous question for context (short messages, or messages with words like he/she/it/they)
    let query = userText;
    const isShort = userText.split(/\s+/).length < 8;
    const hasPronoun = /\b(he|she|it|its|they|them|their|him|his|her|that|this|those|these|there)\b/i.test(userText);
    if (isShort || hasPronoun) {
        const lastUser = [...history].reverse().find(entry => entry.role === 'user');
        const lastText = lastUser?.parts?.[0]?.text?.replace(/^[^:]{1,40}:\s*/, '');
        if (lastText) query = `${lastText.slice(0, 200)} ${userText}`;
    }
    query = query.slice(0, 380); // Tavily accepts at most 400 characters

    try {
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TAVILY_API_KEY}`
            },
            body: JSON.stringify({ query, search_depth: 'basic', max_results: 5 }),
            signal: AbortSignal.timeout(15_000)
        });

        if (!res.ok) {
            console.warn(`Web search failed (HTTP ${res.status}), answering without it.`);
            return '';
        }

        const data = await res.json();
        const results = (data.results || []).slice(0, 5);
        if (!results.length) return '';

        console.log(`Web search used for: "${query.slice(0, 80)}" (${results.length} results)`);
        const lines = results.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${(r.content || '').slice(0, 800)}`);
        return `[Web search results fetched just now for: "${query}"]\n${lines.join('\n\n')}`;
    } catch (err) {
        console.warn('Web search error, answering without it:', err.message);
        return '';
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
async function requestGemini(model, contents, withSearch, hasWebResults) {
    const body = {
        systemInstruction: { parts: [{ text: buildSystemInstruction(withSearch, hasWebResults, model) }] },
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
async function askGemini(contents, channelId, userId, hasWebResults = false) {
    let lastError;
    const startedAt = Date.now();

    // Priority: the user's personal model, then the channel model, then the default models as backups
    const modelsToTry = [...new Set([
        userModels.get(userId),
        channelModels.get(channelId),
        ...MODEL_CHAIN
    ].filter(Boolean))];

    for (const model of modelsToTry) {
        // Google's own search is only a fallback for when Tavily isn't set up. With Tavily on, skipping it
        // saves a slow extra request on every message (and doesn't touch Google's small search quota).
        const searchAllowed = USE_SEARCH && !WEB_SEARCH_ENABLED && !hasWebResults && Date.now() >= searchBlockedUntil;
        const attempts = searchAllowed ? [true, false] : [false];

        for (const withSearch of attempts) {
            try {
                const data = await requestGemini(model, contents, withSearch, hasWebResults);

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
                    console.log(`Answered with model=${model}, googleSearch=${withSearch}, grounded=${Boolean(candidate?.groundingMetadata)}, webResults=${hasWebResults}, version=${data.modelVersion ?? 'unknown'}, took=${Date.now() - startedAt}ms`);
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

// Shared by normal chat messages and /ask-duro: builds the prompt, looks things up on the web if needed,
// asks Gemini, remembers the exchange, and returns the final answer text
async function generateAnswer({ channelId, userId, author, userText, imageParts = [] }) {
    const promptText = `${author}: ${userText}`;
    const history = channelHistory.get(channelId) ?? [];

    // Fresh info from the internet (only for questions that need it, and only if TAVILY_API_KEY is set)
    const webResults = await getWebResults(userText, history);

    const userParts = [{ text: promptText }];
    if (webResults) userParts.push({ text: webResults });
    userParts.push(...imageParts);

    const contents = [...history, { role: 'user', parts: userParts }];

    let answer = await askGemini(contents, channelId, userId, Boolean(webResults));

    // Safety net: remove a leading "Name:" if the model still copies the prefix
    const prefix = `${author}:`;
    if (answer.startsWith(prefix)) answer = answer.slice(prefix.length).trim();

    // Only remember the exchange if it worked
    addToHistory(channelId, 'user', imageParts.length ? `${promptText} [attached ${imageParts.length} image(s)]` : promptText);
    addToHistory(channelId, 'model', answer);

    return answer;
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
            ),
        // Open to everyone: ask Duro something in ANY server channel (not in DMs), even if it isn't an AI channel
        new SlashCommandBuilder()
            .setName('ask-duro')
            .setDescription('Ask Duro a question in any channel.')
            .setDMPermission(false)
            .addStringOption(option =>
                option
                    .setName('message')
                    .setDescription('What do you want to ask Duro?')
                    .setRequired(true)
                    .setMaxLength(1000)
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

            case 'ask-duro': {
                const userText = interaction.options.getString('message', true).trim();
                if (!userText) {
                    await interaction.reply({ content: '⚠️ Type a question after `/ask-duro`.', flags: MessageFlags.Ephemeral });
                    break;
                }

                const waitMs = ASK_COOLDOWN_MS - (Date.now() - (askCooldowns.get(interaction.user.id) ?? 0));
                if (waitMs > 0) {
                    await interaction.reply({ content: `⏳ Please wait ${Math.ceil(waitMs / 1000)} more second(s) before asking again.`, flags: MessageFlags.Ephemeral });
                    break;
                }
                askCooldowns.set(interaction.user.id, Date.now());

                // Thinking can take longer than Discord's 3-second limit, so acknowledge right away
                await interaction.deferReply();
                const safeMentions = { parse: [] };

                try {
                    const answer = await generateAnswer({
                        channelId,
                        userId: interaction.user.id,
                        author: interaction.member?.displayName || interaction.user.username,
                        userText
                    });

                    const chunks = splitMessage(answer);
                    await interaction.editReply({ content: chunks[0], allowedMentions: safeMentions });
                    for (const chunk of chunks.slice(1)) {
                        await interaction.followUp({ content: chunk, allowedMentions: safeMentions });
                    }
                } catch (error) {
                    console.error('/ask-duro error:', error);
                    await interaction.editReply({ content: friendlyErrorMessage(error), allowedMentions: safeMentions }).catch(() => {});
                }
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
// Automod: enforces the clear-cut server rules in EVERY channel
//   Rule 1: no notification spam (flooding, repeating, mass mentions)
//   Rule 2: no invites to other servers
// Staff (Administrator, Manage Messages, Moderate Members, Manage Server) are never touched.
// Punishments grow with repeat offenses: warning -> 10 min -> 1 hour -> 3 hours timeout.
// ---------------------------------------------------------------------------
const AUTOMOD_ENABLED = (process.env.AUTOMOD ?? 'true').toLowerCase() !== 'false';
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

const AUTOMOD_FLOOD_COUNT = 6;                  // this many messages ...
const AUTOMOD_FLOOD_WINDOW_MS = 8_000;          // ... within this time = flooding
const AUTOMOD_REPEAT_COUNT = 3;                 // the same text this many times ...
const AUTOMOD_REPEAT_WINDOW_MS = 30_000;        // ... within this time = repeating
const AUTOMOD_MAX_USER_MENTIONS = 5;            // pinging this many different people in one message
const AUTOMOD_MAX_ROLE_MENTIONS = 2;            // pinging this many roles in one message
const AUTOMOD_COOLDOWN_MS = 15_000;             // one burst of spam only counts as ONE strike
const STRIKE_MEMORY_MS = 24 * 60 * 60 * 1000;   // strikes are forgotten after 24 hours
const PUNISHMENT_STEPS_MIN = [0, 10, 60, 180];  // strike 1 = warning, 2 = 10 min, 3 = 1 hour, 4 and more = 3 hours

const INVITE_PATTERN = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,32})/gi;

const modRecentMessages = new Map();  // userId -> [{ time, text }]
const modStrikes = new Map();         // userId -> [timestamps]
const modCooldownUntil = new Map();   // userId -> time

// Looks at one message and returns what rule it breaks, or null if it is fine
async function findViolation(message) {
    const userId = message.author.id;
    const now = Date.now();
    const text = message.content ?? '';
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');

    // Remember this person's latest messages for flood / repeat detection
    const recent = (modRecentMessages.get(userId) ?? []).filter(m => now - m.time < AUTOMOD_REPEAT_WINDOW_MS);
    recent.push({ time: now, text: normalized });
    modRecentMessages.set(userId, recent);

    // Rule 2: an invite to ANOTHER server (invites to this server are fine)
    const codes = [...text.matchAll(INVITE_PATTERN)].map(match => match[1]).slice(0, 3);
    for (const code of codes) {
        const invite = await client.fetchInvite(code).catch(() => null);
        if (invite?.guild && invite.guild.id !== message.guild.id) {
            return { rule: 'Rule 2 (No Self-Promotion)', reason: 'posting an invite to another server', deleteMessage: true };
        }
    }

    // Rule 1: mass mentions
    if (message.mentions.users.size >= AUTOMOD_MAX_USER_MENTIONS || message.mentions.roles.size >= AUTOMOD_MAX_ROLE_MENTIONS) {
        return { rule: 'Rule 1 (No Notification Spam)', reason: 'mass mentions', deleteMessage: true };
    }

    // Rule 1: flooding (many messages very fast)
    if (recent.filter(m => now - m.time < AUTOMOD_FLOOD_WINDOW_MS).length >= AUTOMOD_FLOOD_COUNT) {
        return { rule: 'Rule 1 (No Notification Spam)', reason: 'flooding the chat', deleteMessage: false };
    }

    // Rule 1: repeating the same message
    if (normalized && recent.filter(m => m.text === normalized).length >= AUTOMOD_REPEAT_COUNT) {
        return { rule: 'Rule 1 (No Notification Spam)', reason: 'repeating the same message', deleteMessage: false };
    }

    return null;
}

const formatMinutes = (minutes) => minutes >= 60 ? `${minutes / 60} hour${minutes >= 120 ? 's' : ''}` : `${minutes} minutes`;

// Warns or times out the person and reports it to the mods
async function enforceViolation(message, violation) {
    const member = message.member;
    const userId = message.author.id;
    const now = Date.now();

    modCooldownUntil.set(userId, now + AUTOMOD_COOLDOWN_MS);
    modRecentMessages.delete(userId); // start fresh after the punishment

    const strikes = (modStrikes.get(userId) ?? []).filter(time => now - time < STRIKE_MEMORY_MS);
    strikes.push(now);
    modStrikes.set(userId, strikes);

    const minutes = PUNISHMENT_STEPS_MIN[Math.min(strikes.length, PUNISHMENT_STEPS_MIN.length) - 1];
    const noMentions = { parse: [], users: [userId] }; // ping only the offender, nobody else

    if (violation.deleteMessage) await message.delete().catch(() => {});

    let action = 'warning';
    let failure = '';

    if (minutes > 0) {
        try {
            if (!member?.moderatable) throw new Error("Duro can't time this person out (its role needs to be above theirs, with the Moderate Members permission)");
            await member.timeout(minutes * 60_000, `${violation.rule}: ${violation.reason}`);
            action = `timeout for ${formatMinutes(minutes)}`;
        } catch (error) {
            failure = error.message;
            action = 'warning (timeout failed)';
            console.error('Automod timeout failed:', error.message);
        }
    }

    // Public notice in the channel
    const notice = action.startsWith('timeout')
        ? `⏱️ <@${userId}> was timed out for ${formatMinutes(minutes)}: ${violation.reason} (${violation.rule}).`
        : `⚠️ <@${userId}> warning: please stop ${violation.reason} (${violation.rule}). Next time it means a timeout.`;
    await message.channel.send({ content: notice, allowedMentions: noMentions }).catch(() => {});

    // Report for the mods
    console.log(`Automod: ${message.author.username} -> ${action} (${violation.reason}, strike ${strikes.length})`);
    if (MOD_LOG_CHANNEL_ID) {
        const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID).catch(() => null);
        const snippet = (message.content || '(no text)').slice(0, 200);
        await logChannel?.send({
            content: `🛡️ **Automod** | ${message.author.username} (<@${userId}>) in <#${message.channel.id}>\n` +
                `Reason: ${violation.reason} (${violation.rule})\nAction: ${action} (strike ${strikes.length} in 24h)\n` +
                (failure ? `Problem: ${failure}\n` : '') + `Message: ${snippet}`,
            allowedMentions: { parse: [] }
        }).catch(() => {});
    }
}

// Returns true if the message broke a rule and was handled (so Duro should not answer it)
async function runAutomod(message) {
    try {
        const staffPermissions = [
            PermissionFlagsBits.Administrator,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ModerateMembers,
            PermissionFlagsBits.ManageGuild
        ];
        if (message.member?.permissions.any(staffPermissions)) return false;

        const violation = await findViolation(message);
        if (!violation) return false;

        // Same burst of spam: no extra strike, but still remove mass-mention / invite messages
        if (Date.now() < (modCooldownUntil.get(message.author.id) ?? 0)) {
            if (violation.deleteMessage) await message.delete().catch(() => {});
            return true;
        }

        await enforceViolation(message, violation);
        return true;
    } catch (error) {
        console.error('Automod error:', error);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Spam and nonsense filter (for normal chat in AI channels; /ask-duro is always answered)
// ---------------------------------------------------------------------------
const SPAM_WINDOW_MS = 30_000;        // look at the last 30 seconds of a person's messages
const SPAM_MAX_MESSAGES = 5;          // more than this many in the window = flooding
const DUPLICATE_WINDOW_MS = 60_000;   // the exact same text again within a minute is ignored

// Words that carry no question or meaning by themselves (add your own, lowercase)
const FILLER_WORDS = new Set([
    'ok', 'okay', 'k', 'kk', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'lol', 'lmao', 'lmfao', 'rofl',
    'xd', 'uh', 'um', 'ah', 'oh', 'ohh', 'bruh', 'bro'
]);
// Rows of the keyboard, like someone mashing keys
const KEYBOARD_MASH = /asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|uiop|zxcv|xcvb|cvbn|vbnm/i;

const recentMessageTimes = new Map();  // userId -> timestamps of their latest messages
const lastMessageByUser = new Map();   // userId -> { text, time } of their previous message
const usersBeingAnswered = new Set();  // people Duro is answering right now (their extra messages are ignored)

// Returns a short reason if the text means nothing, or null if it looks like a real message
function nonsenseReason(rawText) {
    // Remove parts that carry no meaning on their own: custom emoji, mentions and links
    const cleaned = rawText
        .replace(/<a?:\w+:\d+>/g, ' ')
        .replace(/<[@#&!]+\d+>/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .trim();

    if (!/[\p{L}\p{N}]/u.test(cleaned)) return 'no real words (emoji, symbols or links only)';

    const tokens = cleaned.toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{M}\p{N}]/gu, '')).filter(Boolean);
    const compact = tokens.join('');

    if (compact.length < 2) return 'too short to mean anything';
    if (compact.length >= 4 && /^(.+?)\1+$/u.test(compact)) return 'the same thing repeated';
    if (tokens.every(token => FILLER_WORDS.has(token))) return 'filler words only';
    if (tokens.some(token => token.length >= 5 && KEYBOARD_MASH.test(token))) return 'keyboard mashing';
    if (tokens.some(token => /^[a-z]{7,}$/.test(token) && !/[aeiouy]/.test(token))) return 'random letters';
    return null;
}

// Decides if Duro should stay silent for this message (returns the reason, or null to answer it)
function shouldIgnoreMessage(message, hasImages) {
    const userId = message.author.id;
    const now = Date.now();
    const text = message.content.trim();

    // Flooding: too many messages in a short time
    const times = (recentMessageTimes.get(userId) ?? []).filter(time => now - time < SPAM_WINDOW_MS);
    times.push(now);
    recentMessageTimes.set(userId, times);
    if (times.length > SPAM_MAX_MESSAGES) return 'flooding (too many messages too fast)';

    // Duro is already busy answering this person: don't pile up requests
    if (usersBeingAnswered.has(userId)) return 'still answering this person';

    // The exact same message again
    const previous = lastMessageByUser.get(userId);
    lastMessageByUser.set(userId, { text: text.toLowerCase(), time: now });
    if (text && previous && previous.text === text.toLowerCase() && now - previous.time < DUPLICATE_WINDOW_MS) {
        return 'the same message again';
    }

    // Text that means nothing (a picture with no words is fine)
    if (!hasImages) return nonsenseReason(text);
    return null;
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) return;

    // Server rules first: this runs in EVERY channel, not only AI channels
    if (AUTOMOD_ENABLED && await runAutomod(message)) return;

    if (!activeChannels.has(message.channel.id)) return;

    const hasImages = [...message.attachments.values()].some(a => a.contentType?.startsWith('image/'));
    if (!message.content.trim() && !hasImages) return;

    // Stay silent for spam and messages that mean nothing
    const ignoreReason = shouldIgnoreMessage(message, hasImages);
    if (ignoreReason) {
        console.log(`Ignored a message from ${message.author.username}: ${ignoreReason}`);
        return;
    }
    usersBeingAnswered.add(message.author.id);

    // Discord's typing indicator lasts ~10 seconds, so refresh it while waiting for the AI
    message.channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

    try {
        const author = message.member?.displayName || message.author.username;
        const userText = message.content.trim() || '(image only)';
        const imageParts = await buildImageParts(message);

        const answer = await generateAnswer({
            channelId: message.channel.id,
            userId: message.author.id,
            author,
            userText,
            imageParts
        });

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
        usersBeingAnswered.delete(message.author.id);
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
