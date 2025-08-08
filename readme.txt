This is a simple bot to record participants in a voice call, with each saved
to a different file.

This should be considered highly experimental at the moment.

Go to the Discord dev portal, create a new app, and get the app token. I have
no idea how this works, Mineman did it, go bug him.

Put the token in a file called .recordbotkey in your home directory. If you're
not sure what your "home" directory is on your platform, running the script
for the first time will tell you where to put it.

Install Node, then npm install discord.js, @discordjs/voice, and prism-media.

Run `node recordbot.js` to start it. Then install it in your server. Again, go
bug Mineman.

Once the bot is running on your server, join a voice channel and send a
message somewhere on the server saying !start. The bot will join the channel
and start recording. When finished, say !stop

Once recording is finished, the bot will send copies of the recordings to the
server. They'll also be saved in the 'recordings' directory in the directory
the script is run from.

The files are in a custom format: Run the `decoderecording.py` script on them
to convert them into .wav files.
