/* Modules */
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const { spawn } = require( 'node:child_process' );
const process = require( 'node:process' );
const prism = require('prism-media');
const toml = require( 'toml' );
const fs = require('fs');
const os = require('os');
const path = require('path');

const configPath = path.join( os.homedir(), ".recordbot" )

// Default configuration
var config = {
    recordrate: 48000,
    recordchannels: 2,
    recordframeSize: 960,
    recordpath: path.join( __dirname, 'recordings' ),
    postprocessorpath: path.join( __dirname, 'postrecord.sh' )
}

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


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

/* Record the audio from a given voice chat channel */

class Recorder
{
    connection; // Voice channel connection
    recordingStreams = {}; // userId -> { audioStream, outputStream }
    sessionPath; // Path to recording files
    startTime; // Timestamp of start of recordings
    guild; // The server
    channel; // The channel to record (as a Channel object)
    startMessage; // The message that started recording

    constructor( channel, message )
    {
        this.guild = channel.guild;
        this.channel = channel;
        this.startMessage = message;
        // Create a new session folder
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.sessionPath = path.join(
            config.recordpath, `session-${timestamp}` );
        if( !fs.existsSync( config.recordpath ))
        {
            fs.mkdirSync( config.recordpath, { recursive: true } );
        }
        fs.mkdirSync( this.sessionPath );

        this.connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator
        });

        this.startTime = Date.now();

        // Record all current members
        channel.members.forEach( member => {
            this.addUser( member );
        });

    }

    addUser( member )
    {
        if( member.user.bot ) return; // Ignore bots

        const audioStream = this.connection.receiver.subscribe(
            member.id, {
                end: { behavior: EndBehaviorType.Manual }
        });

        let outputStream;

        if( !(member.id in this.recordingStreams) )
        {
            const safeUsername = member.user.username.replace(
                /[^a-z0-9_\-]/gi, '_' );
            const fileName = path.join(
                this.sessionPath, `${safeUsername}.drb` );

            outputStream = fs.createWriteStream( fileName );
            writeBlob( outputStream, 'DRBT' );
            writeBlob( outputStream, 'RSPS', config.recordrate );
            writeBlob( outputStream, 'RCHN', config.recordchannels );
            writeBlob( outputStream, 'RFRS', config.recordframeSize );
            writeBlob( outputStream, 'TIME',
                Math.floor( this.startTime / 1000 ));
            writeBlob( outputStream, 'GULD', this.guild.name );
            writeBlob( outputStream, 'CHNL', this.channel.name );
            writeBlob( outputStream, 'USER', member.user.username );
            writeBlob( outputStream, 'DATA' );
            this.recordingStreams[member.id] = { audioStream, outputStream };
            console.log( `Recording started for ${member.user.username}` );
        }
        else
        {
            /* If this user was previously being recorded, we'll use the new
             * audio stream we created, but keep the output filehandle that we
             * left open, and just append more audio chunks to it. The
             * timestamped nature of the file format will keep things in sync.
             */
            this.recordingStreams[member.id].audioStream = audioStream;
            outputStream = this.recordingStreams[member.id].outputStream;
            console.log( `Recording re-started for ${member.user.username}` );
        }

        const decoder = new prism.opus.Decoder({ 
            rate: config.recordrate, 
            channels: config.recordchannels,
            frameSize: config.recordframeSize
        });

        audioStream.pipe(decoder).on( 'data', (chunk) => {
            // console.log( `Received ${chunk.length} bytes of data.` );
            writeBlob( outputStream, 'RPKT' );
            writeBlob( outputStream, 'STMP', Date.now() - this.startTime );
            writeBlob( outputStream, 'PCM0', chunk );
        });
    }

    removeUser( member )
    {
        if( !(member.id in this.recordingStreams) )
        {
            /* Not sure how this happened, but we were never recording
             * this user! */
            return;
        }

        /* We're going to dump the audio stream coming from discord,
         * but keep the output stream. If the user rejoins, we'll continue
         * appending to it as if nothing happened.
         */

        this.recordingStreams[member.id].audioStream.destroy();
        this.recordingStreams[member.id].audioStream = null;

        console.log( `Stopped recording for ${member.user.username}` );

        /* See if any human members are left */
        let humans = false;
        this.channel.members.forEach( member => {
            if( !member.user.bot )
            {
                humans = true;
            }
        });
        if( humans ) return;

        /* No human participants remaining, shutdown automatically */
        this.stopRecordings();

    }

    /* Finish recording and shut down any streams.
     *
     * This is called when a !stop command is issued, 
     * or when the bot is shut down
     */

    stopRecordings( message=undefined )
    {
        // Stop all streams and intervals
        for( const { audioStream, outputStream } of 
            Object.values( this.recordingStreams ))
        {
            outputStream.end();
        }

        this.connection.destroy();

        delete recorders[this.channel.id];

        /* If we weren't shut down by a stop command, reply to the message that
         * was used to start recordings */
        if( !message ) message = this.startMessage;
        const reply = message.author.send(
            `Recording stopped for ${this.channel.name}` ).then( reply => {
                // Run the postprocessor script

                let scriptenv = {
                    REC_SERVER: this.guild.name,
                    REC_CHANNEL: this.channel.name,
                    REC_TIME: Math.floor( this.startTime / 1000 ),
                    REC_BASEDIR: __dirname
                }

                if( 'postprocessor' in config )
                {
                    scriptenv = {...scriptenv, ...config.postprocessor };
                }

                let child = spawn( config.postprocessorpath, [], { 
                    env: { ...process.env, ...scriptenv },
                    cwd: this.sessionPath
                });

                /* Listen for output from the postprocessor. Each line that comes
                 * in, edit our reply to add a status update */
                let buffer = ""
                child.stdout.on( 'data', chunk => {
                    chunk = chunk.toString();
                    const lines = chunk.split( "\n" );
                    let line = null;
                    // console.log( lines.length );
                    if( lines.length == 1 )
                    {
                        buffer += chunk;
                    }
                    else if( lines.length == 2 )
                    {
                        buffer += lines[0];
                        line = buffer;
                        buffer = '';
                    }
                    else
                    {
                        line = lines[lines.length - 2];
                        buffer = lines[lines.length - 1];
                    }

                    // console.log( `Received chunk: ${chunk}` );
                    if( line )
                    {
                        reply.edit( line );
                        line = null;
                    }
                });
            }).catch( (error) => {
                console.log( "Couldn't send message to user." );
                console.log( error );
            });
    }
}

recorders = {};

client.on( 'ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on( 'messageCreate', async (message) => {
    if( message.author.bot ) return;

    if( message.content === '!start' )
    {
        if( !message.member.voice.channel )
        {
            return message.reply(
                "You're not in a voice channel in this server" );
        }
        if( recorders[message.member.voice.channel.id] )
        {
            return message.reply( 'Already recording this channel!' );
        }

        recorder = new Recorder( message.member.voice.channel, message );
        recorders[message.member.voice.channel.id] = recorder;

        message.reply(
            `Recording started. Session folder: ${recorder.sessionPath}` );
    }

    if( message.content === '!stop' )
    {
        if( !message.member.voice.channel )
        {
            return message.reply( "You're not in a voice channel" );
        }
        const cid = message.member.voice.channel.id;
        if( !(cid in recorders) )
        {
            return message.reply( 'Not recording this channel' );
        }
        recorders[cid].stopRecordings( message );
    }
});

// Handle users joining or leaving
client.on( 'voiceStateUpdate', (oldState, newState) => {
    /* This event is fired when a user joins or leaves a voice channel, or when
     * some other status changes. oldState and newState contain the previous
     * and new states. Of interest are the channelId and member members, which
     * contain the channel and user in question. The channelId may be null
     * (user was not in a channel or left a channel) or the ID of the channel
     * they left/joined. */

    if( oldState.channelId == newState.channelId )
    {
        /* Channel was not changed. This event represents some other
         * status change. */
        return;
    }

    if( oldState.channelId )
    {
        /* User left a channel */
        if( oldState.channelId in recorders )
        {
            recorders[oldState.channelId].removeUser( oldState.member );
        }
    }

    if( newState.channelId )
    {
        /* User joined a channel */
        if( newState.channelId in recorders )
        {
            recorders[newState.channelId].addUser( newState.member );
        }
    }

});

function shutdown( reason )
{
    console.log( `Shutting down: ${reason}` );
    Object.values( recorders ).forEach( recorder => {
        recorder.stopRecordings();
    });
    client.destroy();

}

process.on( 'SIGHUP', () => {
    shutdown( "Hangup" );
});

process.on( 'SIGINT', () => {
    shutdown( "Interrupt" );
});

process.on( 'SIGTERM', () => {
    shutdown( "Terminate" );
});

if( !fs.existsSync( configPath ))
{
    console.log( `Please create a configuration file with a token in ${configPath}` );
}
else
{
    config = { ...config, ...(toml.parse( fs.readFileSync( configPath ))) };
    key = config.token
    client.login( key );
}

