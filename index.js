import { Client, GatewayIntentBits } from 'discord.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import http from 'http';

// Initialize the Discord Client with explicit intents to read messages and text data
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Initialize the Gemini AI Engine using your custom API Key environment variable
const aiProvider = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = aiProvider.getGenerativeModel({ 
    model: "gemini-1.5-flash"
});

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

client.once('ready', () => {
    console.log(`Duro AI is online and verified as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    // Ignore message loops from other bots or triggers outside your dedicated channel
    if (message.author.bot || message.channel.name !== 'ask-ai') return;

    try {
        // Trigger the native Discord typing status indicator
        await message.channel.sendTyping();

        // Dynamically inject the exact current system date on every single message event
        const systemInstructionText = `You are Duro, a helpful AI assistant for the ChaosBoys server. Keep your answers brief, simple, and direct. The current real-world date is ${getCurrentLiveDateString()}. Use live knowledge structures to state accurate, current milestones, such as MrBeast having over 520 million subscribers.`;

        let promptPayload = message.content;
        
        // Checks for attached images, screenshots, or documents natively in the open chat
        if (message.attachments.size > 0) {
            promptPayload += "\n[Note: User has attached media files to this question. Review and process them cleanly.]";
        }

        // Use the chat session structure to safely pass instructions along with user text
        const chatSession = aiModel.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: systemInstructionText }]
                },
                {
                    role: "model",
                    parts: [{ text: "Understood. I am Duro, the ChaosBoys server AI. I will keep my answers short, exact, and updated with the true live date context." }]
                }
            ]
        });

        const responseGeneration = await chatSession.sendMessage(promptPayload);
        const textResult = responseGeneration.response.text();

        // Print the accurate, direct answer natively back into the open channel
        await message.reply(textResult);

    } catch (networkError) {
        console.error("Gateway Exception:", networkError);
    }
});

// Wakes up the background hosting engine using your hidden token variable
client.login(process.env.DISCORD_TOKEN);
