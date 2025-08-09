This is a simple bot to record participants in a voice call, with each saved
to a different file.

This should be considered highly experimental at the moment.

Go to the [Discord developer portal](https://discord.com/developers/applications), create a new app, and go down to the Bot tab, reset the token and then copy it, you'll need it.

Put the token in a file called .recordbotkey in your home directory. If you're
not sure what your "home" directory is on your platform, running the script
for the first time will tell you where to put it.

Install Node, then `npm install` to install the dependencies.

Run `node recordbot.js` to start it. Then go to the Installation tab, and make sure "Guild Install" is checked. Make sure that `bot` is selected in the scopes section. then copy the invite link into a new tab and select your server.

Once the bot is running on your server, join a voice channel and send a
message somewhere on the server saying !start. The bot will join the channel
and start recording. When finished, say !stop

Once recording is finished, they'll be saved in the 'recordings' directory in the directory
the script is run from.

The files are in a custom format: Run the `decoderecording.py` script on them
to convert them into .wav files.