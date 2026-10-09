import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import http from 'http';

// Initialize the Discord Client with explicit intents to read messages and text data
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store the active AI channel ID in memory (starts empty)
let activeAiChannelId = null;

// Dynamic date calculation function ensures the calendar stays correct forever
const getCurrentLiveDateString = () => {
    return new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
};

// Creates a simple internal web listener so Render's port scanner turns green
const webServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Duro AI is active and running 24/7\n');
});
const serverPort = process.env.PORT || 10000;
webServer.listen(serverPort, '0.0.0.0', () => {
    console.log(`Port scanner listener active on gateway port ${serverPort}`);
});

// Register the slash commands dynamically when the bot starts up
client.once('ready', async () => {
    console.log(`Duro AI is online and verified as ${client.user.tag}!`);

    const slashCommands = [
        new SlashCommandBuilder()
            .setName('set-ai-channel')
            .setDescription('Set the current channel as the active AI conversation room.'),
        new SlashCommandBuilder()
            .setName('remove-ai-channel')
            .setDescription('Remove the AI chatbot from the active channel configuration.')
    ].map(command => command.toJSON());

    const restClient = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        await restClient.put(
            Routes.applicationCommands(client.user.id),
            { body: slashCommands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (commandError) {
        console.error('Failed to register slash commands:', commandError);
    }
});

// Handle the interaction of running commands inside channels
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'set-ai-channel') {
        activeAiChannelId = interaction.channelId;
        await interaction.reply(`🤖 **Duro AI Channel Locked!** I am now activated for all messages sent in this channel.`);
    } 
    else if (commandName === 'remove-ai-channel') {
        if (activeAiChannelId === interaction.channelId) {
            activeAiChannelId = null;
            await interaction.reply(`❌ **Duro AI Removed!** I will no longer automatically respond to text messages in this channel.`);
        } else {
            await interaction.reply(`⚠️ This channel is not currently set as the active Duro AI channel.`);
        }
    }
});

client.on('messageCreate', async (message) => {
    // Ignore message loops from other bots or triggers outside your designated channel ID
    if (message.author.bot || message.channel.id !== activeAiChannelId) return;

    try {
        // Trigger the native Discord typing status indicator
        await message.channel.sendTyping();

        // System prompt instruction forces dynamic live 2026 dates and brief answers
        const systemInstructionText = `You are Duro, a helpful AI assistant for the ChaosBoys server. Keep your answers brief, simple, and direct. The current real-world date is ${getCurrentLiveDateString()}. Use live knowledge structures to state accurate, current milestones, such as MrBeast having over 520 million subscribers.`;

        let userPrompt = message.content;
        if (message.attachments.size > 0) {
            userPrompt += "\n[Note: User has attached media files to this question. Review and process them cleanly.]";
        }

        // Build a direct, lightweight raw web request payload for Gemini API
        const apiEndpoint = `https://googleapis.com{process.env.GEMINI_API_KEY}`;
        
        const requestPayload = {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemInstructionText }] }
        };

        const apiResponse = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload)
        });

        const dataResult = await apiResponse.json();
        
        // FIXED SYNTAX: Safely extract the text result from the API response object
        const aiTextOutput = dataResult.candidates?.[0]?.content?.parts?.[0]?.text;

        if (aiTextOutput) {
            await message.reply(aiTextOutput);
        } else {
            console.error("API Error Object:", dataResult);
            await message.reply("⚠️ Duro encountered an internal layout error processing this question.");
        }

    } catch (networkError) {
        console.error("Gateway Exception:", networkError);
    }
});

// Wakes up the background hosting engine using your hidden token variable
client.login(process.env.DISCORD_TOKEN);
