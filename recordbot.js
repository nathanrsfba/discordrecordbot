const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const os = require('os');
const path = require('path');
const keyfile = path.join( os.homedir(), ".recordbotkey" )
/*
 * Write a block of type name to the stream
 */
function writeBlob( stream, name, data )
{
    stream.write( Buffer.from( name ));
    if( data === null || data === undefined ) data = "";
    // Convert strings to buffers so we get an accurate length
    // for UTF encoded data
    data = Buffer.from( data );
    buffer = Buffer.alloc( 4 );
    buffer.writeInt32BE( data.length );
    stream.write( buffer );
    stream.write( data );
}

/*
 * Write a 32-bit int blob
 */

function writeBlobInt( stream, name, data )
{
    buffer = Buffer.alloc( 4 );
    buffer.writeInt32BE( data );
    writeBlob( stream, name, buffer );
}

const recordRate = 48000;
const recordChannels = 2;
const recordFrameSize = 960;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const recordingsRoot = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsRoot)) fs.mkdirSync(recordingsRoot);

let connection;
let recordingStreams = {}; // userId -> { audioStream, outputStream }
let activeChannelId;
let sessionPath;
let startTime;
let guildName;
let channelName;

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!start') {
        if (!message.member.voice.channel) {
            return message.reply('You must be in a voice channel to start recording.');
        }
        if (connection) {
            return message.reply('Already recording!');
        }

        channelName = message.member.voice.channel.name;
        guildName = message.member.voice.channel.guild.name;

        // Create a new session folder
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        sessionPath = path.join(recordingsRoot, `session-${timestamp}`);
        fs.mkdirSync(sessionPath);

        const channel = message.member.voice.channel;
        activeChannelId = channel.id;

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        startTime = Date.now();
        
        // Record all current members
        channel.members.forEach(member => {
            if (!member.user.bot) startUserRecording(member.id, member.user.username);
        });

        message.reply(`Recording started. Session folder: ${sessionPath}`);
    }

    if (message.content === '!stop') {
        if (!connection) return message.reply('Not recording right now.');

        // Stop all streams and intervals
        for (const { audioStream, outputStream } of Object.values(recordingStreams)) {
            outputStream.end();
        }

        recordingStreams = {};

        connection.destroy();
        connection = null;
        activeChannelId = null;

        message.reply('Recording stopped. Uploading files...');

        // Upload all files from the session folder
        fs.readdir(sessionPath, async (err, files) => {
            if (err) return message.channel.send('Error reading session folder.');

            for (const file of files) {
                const filePath = path.join(sessionPath, file);
                if (fs.statSync(filePath).isFile()) {
                    try {
                        await message.channel.send({ files: [filePath] });
                    } catch (uploadErr) {
                        console.error(`Failed to upload ${file}:`, uploadErr);
                    }
                }
            }

            message.channel.send('All recordings uploaded.');
        });
    }
});

// Handle new users joining while recording
client.on('voiceStateUpdate', (oldState, newState) => {
    if (!connection || !activeChannelId) return;

    if (newState.channelId === activeChannelId && !newState.member.user.bot) {
        startUserRecording(newState.id, newState.member.user.username);
    }

    // TODO: Detect user leaving and close recording
});

function startUserRecording(userId, username) {
    if (recordingStreams[userId]) return; // already recording

    const safeUsername = username.replace(/[^a-z0-9_\-]/gi, '_');
    const fileName = path.join(sessionPath, `${safeUsername}.drb`);

    const audioStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual }
    });

    // TODO: Detect file exists == User left and rejoined, append to file and skip header
    const outputStream = fs.createWriteStream( fileName );
    writeBlob( outputStream, 'DRBT', null );
    writeBlobInt( outputStream, 'RSPS', recordRate );
    writeBlobInt( outputStream, 'RCHN', recordChannels );
    writeBlobInt( outputStream, 'RFRS', recordFrameSize );
    writeBlobInt( outputStream, 'TIME', Math.floor( startTime / 1000 ));
    writeBlob( outputStream, 'GULD', guildName );
    writeBlob( outputStream, 'CHNL', channelName );
    writeBlob( outputStream, 'USER', username );
    writeBlob( outputStream, 'DATA', null );

    // writeBlobInt( outputStream, 'CHNL', connection

    const decoder = new prism.opus.Decoder({ 
        rate: recordRate, 
        channels: recordChannels,
        frameSize: 960
    });

    audioStream.pipe(decoder).on( 'data', (chunk) => {
        console.log( `Received ${chunk.length} bytes of data.` );
        writeBlob( outputStream, 'RPKT', null );
        writeBlobInt( outputStream, 'STMP', Date.now() - startTime );
        writeBlob( outputStream, 'PCM0', chunk );
    });
    /*
        recordingStreams[userId].lastPacket = Date.now();
    }).pipe(ffmpeg.stdin);

    // Inject silence if no packets received for >20ms
    const interval = setInterval(() => {
        if (Date.now() - recordingStreams[userId].lastPacket > 20) {
            ffmpeg.stdin.write(SILENCE_FRAME);
        }
    }, 20);
*/

    recordingStreams[userId] = { audioStream, outputStream };

    console.log(`Recording started for ${username}`);
}

function shutdown( reason )
{
    console.log( `Shutting down: ${reason}` );
    client.destroy();

}

process.on( 'SIGINT', () => {
    shutdown( "Interrupt" );
});

process.on( 'SIGTERM', () => {
    shutdown( "Terminate" );
});

if( !fs.existsSync( keyfile ))
{
    console.log( `Please place the discord app key in ${keyfile}` );
}
else
{
    key = fs.readFileSync( keyfile, 'utf8' ).trim();
    client.login( key );
}

