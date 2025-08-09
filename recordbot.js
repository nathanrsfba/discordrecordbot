const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const os = require('os');
const path = require('path');
const keyfile = path.join( os.homedir(), ".recordbotkey" )

/*
 * Write a blob to the stream:
 *
 * stream: The stream to write to (as returned by `fs.createWriteStream`)
 * name: A 4-character ASCII string identifying the blob type
 * data: The data comprising the blob. This can be one of:
 *  * null/undefined/absent: No data. The blob will contain only the signature
 *    and a length of 0, and no payload.
 *  * number: A 32-bit integer; will be written as 4 bytes, big-endian.
 *  * string: A string; will be encoded in UTF-8, with no padding or
 *    termination. The blob length gives the raw, encoded length of the data.
 *  * Buffer: Raw binary data
 */
function writeBlob( stream, name, data )
{
    stream.write( Buffer.from( name ));
    if( data === null || data === undefined ) data = "";
    if( typeof data == 'string' )
    {
        // Convert strings to buffers so we get an accurate length
        // for UTF encoded data
        data = Buffer.from( data );
    }
    else if( typeof data == 'number' )
    {
        buffer = Buffer.alloc( 4 );
        buffer.writeInt32BE( data );
        data = buffer
    }
    size = Buffer.alloc( 4 );
    size.writeInt32BE( data.length );
    stream.write( size );
    stream.write( data );
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
        stopRecordings( message );

    }
});

/* Finish recording and shut down any streams.
 *
 * This is called when a !stop command is issued, or when the bot is shut down
 */

function stopRecordings( message=undefined )
{
    if( !connection ) return;

    // Stop all streams and intervals
    for (const { audioStream, outputStream } of Object.values(recordingStreams)) {
        outputStream.end();
    }

    recordingStreams = {};

    connection.destroy();
    connection = null;
    activeChannelId = null;

    /* If we weren't shut down by a stop command, just exit, because there was
     * nobody to reply to with the recordings. They'll still be saved in the
     * recordings directory however. */
    if( !message ) return;

    message.reply('Recording stopped.');

    /*
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
    */
}

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
    writeBlob( outputStream, 'DRBT' );
    writeBlob( outputStream, 'RSPS', recordRate );
    writeBlob( outputStream, 'RCHN', recordChannels );
    writeBlob( outputStream, 'RFRS', recordFrameSize );
    writeBlob( outputStream, 'TIME', Math.floor( startTime / 1000 ));
    writeBlob( outputStream, 'GULD', guildName );
    writeBlob( outputStream, 'CHNL', channelName );
    writeBlob( outputStream, 'USER', username );
    writeBlob( outputStream, 'DATA' );

    // writeBlobInt( outputStream, 'CHNL', connection

    const decoder = new prism.opus.Decoder({ 
        rate: recordRate, 
        channels: recordChannels,
        frameSize: 960
    });

    audioStream.pipe(decoder).on( 'data', (chunk) => {
        console.log( `Received ${chunk.length} bytes of data.` );
        writeBlob( outputStream, 'RPKT' );
        writeBlob( outputStream, 'STMP', Date.now() - startTime );
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
    stopRecordings();
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

