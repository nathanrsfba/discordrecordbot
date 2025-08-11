#!/bin/sh

# The path to the .drb recoder
DECODER="$REC_BASEDIR/decoderecording.py"
# The timestamp format
TIMEFMT="%Y-%m-%d_%H-%M-%SZ"
# Upload files to this path using rclone
#RCLONE_PATH="dropbox:/recordbot"

# Perform the actual processing
main() {
    #decode_all
    #transcode_all
    #zip_audio
    upload_archive
}

# Decode all .drb files to .wav
decode_all() {
    status "Reconstructing recordings..."

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
    date -d "@$1" +"$TIMEFMT"
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

# Display a message on stdout.
status() {
    echo "$*" 1>&3
}

# Display a message and exit with an error code
error() {
    status "$*"
    exit 1
}

run() {
    main 3>&1 > log.txt 2>&1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Run only if executed directly
    run
fi


