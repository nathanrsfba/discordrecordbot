#!/bin/sh

# This script will automatically transcode completed recordings into the
# desired format, and upload to the desired hosting provider. It is modular, so
# functions can be edited or replaced to customize it for your needs.
#
# You can even `source` it from another script, define replacement functions,
# then call the `run` function at the end to extend it without modifying the
# original.
#
# The script has four main stages:
# 1. Decode the .drb files into .wav files. This uses the included decoder
#    stript. You can customize the `decode_drb` function, which is called on
#    each individual file.
# 2. Transcode the .wav files into flac format. This calls `ffmpeg`, so it
#    requires an ffmpeg with the appropriate codec. You can customize this
#    function, or you can pass the format type to `transcode_all` in the `main`
#    function. This simply changes the file extension in the output filename
#    given to ffmpeg, and thus can be anything ffmpeg recognizes. You could
#    also skip this step to just include the raw .wav.
# 3. Zip the audio files into a single zip file. `zip_audio` does this. By
#    default this calls the `zip_filename` function to generate an output
#    filename, and expects files in flac format. You'll need to supply the
#    latter if you've changed it.
# 4. Upload the arcive to the desired host. The `upload_archive` function does
#    this, calling one of the other upload_ functions, depending on the
#    configuration variables.
#
# Currently supported upload methods:
# * rclone, which will upload to any hosting service supported by it. It will
#   upload to the specified path, then generate a public link and return it.
#   Naturally this requires a service that provides the ability to share files
#   publicly (like Dropbox)
# * Uploading to a web server using sftp (using rsync). The user is expected to
#   provide a user and hostname to the hosting server, and directory to upload
#   into, along with the URL pointing to said directory on the web. It will
#   return a link based on the latter. It assumes SSH keys for the server are
#   provided in ~/.ssh
# * Copying to a local folder. This is useful in place of sftp if the web
#   server is on the local machine
#
# Any output to stdout or stderr from this script is saved to a log file. The
# script can call the `status` function to output a message that will be sent
# to discord in a message. In particular, this should be used at the end of the
# script to post the public link to the uploaded file, which the upload_
# functions do.
#
# Other functions of note:
# * make_timestamp: Turns a Unix time into a human-readable timestamp. This
#   just calls `date` with the $TIMEFMT variable, so just editing the latter
#   should be sufficient.
# * zip_filename: Generates a filename for the final .zip file. By default it
#   generates something based on the server, channel, and timestamp.
# * safe_fn: Replaces all non-alphanumeric characters, plus _, -, and ., with
#   underscores. This will turn a string into something suitable as a filename
#   on any system.
# * error: Displays an error message and exist with error code 1.
#
# This script is called with several environment variables set:
# REC_BASEDIR: The directory of the RecordBot script
# REC_SERVER: The name of the server the recording was taken from
# REC_CHANNEL: The name of the channel the recording was taken from
# REC_TIME: The time of the recording, in Unix time
#
# This script is run in the directory with the recordings from a single
# recording session. Thus, the files it's expected to work with will be in the
# current directory.
#
# There are several configurable variables below

# The path to the .drb recoder
#DECODER="$REC_BASEDIR/decoderecording.py"
# The timestamp format, as accepted by date(1)
#TIMEFMT="%Y-%m-%d_%H-%M-%SZ"

# Upload methods:
# Uncomment one of the following, and point it to the path where you want files
# uploaded.

# Upload files to this path using rclone
#RCLONE_PATH="dropbox:/recordbot"

# Upload using sftp (using rsync) to a hosting provider.
# This assumes you have the appropriate key in ~/.ssh
#SFTP_PATH="user@host:/home/recordbot/recordings"
# The url of the recordings folder, as accessible on the web
#WEB_PATH="http://example.com/recordbot/recordings"

# "Upload" by copying to a local directory. Presumably a web server on the
# local machine is serving out of the given directory.
#LOCAL_PATH="/srv/www/htdocs/recordings"
# The url of the recordings folder, as accessible on the web
#WEB_PATH="http://example.com/recordbot/recordings"

# Perform the actual processing
main() {
    decode_all
    transcode_all
    zip_audio
    upload_archive
}

# Decode all .drb files to .wav
decode_all() {
    status "Reconstructing recordings..."

    if [ "$DECODER" = "" ]; then
        DECODER="$REC_BASEDIR/decoderecording.py"
    fi

    for drb in *.drb; do
        decode_drb $drb || error "Error reconstructing $drb"
    done
}

# Decode an individual .drb file
# $1: The file to decode
decode_drb() {
    "$DECODER" "$drb"
}

# Transcode all .wavs to .flac
# $1: Format to encode to, default flac
transcode_all() {
    format="$1"
    if [ "$format" = "" ]; then
        format="flac"
    fi

    status "Transcoding to $format..."
    for wav in *.wav; do
        out="${wav%.*}.$format"
        # Delete any old files
        rm -f "$out"
        transcode_file "$wav" "$out" || error "Error transcoding $wav"
        # Delete intermediate file
        rm "$wav"
    done
}

# Transcode an individual wav file
# $1: The wav file
# $2: The file to output to
transcode_file() {
    ffmpeg -i "$wav" "$out"
}

# Archive audio files into a zip file
# $1: The target filename (default calls zip_filename)
# $2: The extension of the files (default flac)
zip_audio() {
    filename="$1"
    if [ "$filename" = "" ]; then
        filename="`zip_filename`"
    fi
    format="$2"
    if [ "$format" = "" ]; then
        format="flac"
    fi

    status "Creating zip archive..."

    rm -f "$filename"
    
    zip "$filename" *.$format || error "Error creating zip archive"

    # Delete intermediate files
    rm -f *.$format

}

# Convert a Unix timestamp to a meaningful timestamp
# $1: The time in Unix time
make_timestamp() {
    date -d "@$1" +"${TIMEFMT:-%Y-%m-%d_%H-%M-%SZ}"
}

# Generate the output filename based on passed environment
zip_filename() {
    server=`safe_fn "$REC_SERVER"`
    channel=`safe_fn "$REC_CHANNEL"`
    time=`make_timestamp $REC_TIME`

    echo "${server}_${channel}_${time}.zip"
}

# Convert a filename to only alphanumerics
# $1: The filename (or other string)
safe_fn() {
    echo -n "$1" | tr -c "[^A-Za-z0-9_\-.]" _
}

# Upload the archive. Try to figure out what method to use automatically
# $1: The filename (default calls `zip_filename`)
upload_archive() {
    filename="$1"
    if [ "$1" = "" ]; then
        filename="`zip_filename`"
    fi

    if [ "$RCLONE_PATH" != "" ]; then
        upload_rclone "$filename"
    elif [ "$SFTP_PATH" != "" ]; then
        upload_sftp "$filename"
    elif [ "$LOCAL_PATH" != "" ]; then
        upload_copy "$filename"
    else
        error "No upload method configured"
    fi
}

# Upload using rclone
# $1: The filename (default calls `zip_filename`)
# $2: The target (default $RCLONE_PATH)
upload_rclone() {
    filename="$1"
    if [ "$1" = "" ]; then
        filename="`zip_filename`"
    fi
    target="$2"
    if [ "$2" = "" ]; then
        target="$RCLONE_PATH"
    fi
    status "Uploading..."
    rclone copy "$filename" "$target" || error "Error uploading"
    link="`rclone link "$target/$filename" | tail -1`" || 
        error "Error getting link"
    status "Uploaded to $link"
}

# Upload using sftp
# $1: The filename (default calls `zip_filename`)
# $2: The target path on the server (default $SFTP_PATH)
# $3: The URL of the parent folder on the server (default $WEB_PATH)
upload_sftp() {
    filename="$1"
    if [ "$1" = "" ]; then
        filename="`zip_filename`"
    fi
    target="$2"
    if [ "$2" = "" ]; then
        target="$SFTP_PATH"
    fi
    urlbase="$3"
    if [ "$3" = "" ]; then
        urlbase="$WEB_PATH"
    fi
    status "Uploading..."
    rsync --chmod=644 "$filename" "$target" || error "Error uploading"
    status "Uploaded to $urlbase/$filename"
}

# "Upload" by copying to a local folder. Presumably you have a web server on
# the local machine serving out of the given folder.
# $1: The filename (default calls `zip_filename`)
# $2: The target folder (default $LOCAL_PATH)
# $3: The URL of the parent folder on the server (default $WEB_PATH)
upload_copy() {
    filename="$1"
    if [ "$1" = "" ]; then
        filename="`zip_filename`"
    fi
    target="$2"
    if [ "$2" = "" ]; then
        target="$LOCAL_PATH"
    fi
    urlbase="$3"
    if [ "$3" = "" ]; then
        urlbase="$WEB_PATH"
    fi
    status "Uploading..."
    (cp "$filename" "$target" && chmod 644 "$target/$filename") ||
        error "Error uploading"
    status "Uploaded to $urlbase/$filename"
}

# Display a message on stdout.
status() {
    echo "$*" 1>&3
}

# Display a message and exit with an error code
error() {
    status "$*"
    exit 1
}

# Run the actual process, with IO redirected. If you source this script, call
# this function at the end of your script.
run() {
    main 3>&1 > log.txt 2>&1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Run only if executed directly
    run
fi


