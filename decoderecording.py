from collections import namedtuple
from math import floor
from argparse import ArgumentParser
from pathlib import Path
import wave

class Blob:
    """A blob of recording data or information"""

    def __init__( self, sig, size, data ):
        self.sig = sig
        self.size = size
        self.data = data

    def __int__( self ):
        """Convert blob data (presumed big-endian) to an int"""
        return int.from_bytes( self.data, byteorder='big' )

    def __str__( self ):
        """Convert blob data (presumed UTF-8) into a string"""
        return self.data.decode()

    def __bytes__( self ):
        """Convert blob data into bytes (returns blob.data)"""
        return self.data

class BlobFile:
    """A file of Blob objects"""
    def __init__( self, fd ):
        self.fd = fd

    def __enter__( self ):
        return self

    def __exit__( self, type, value, traceback ):
        self.fd.__exit__( type, value, traceback )
    
    @classmethod
    def open( cls, path, mode='rb' ):
        """Open the given file and return a BlobFile object"""
        fd = open( path, mode )
        fd.__enter__()
        return cls( fd )

    def next( self ):
        """Read the next Blob. Returns None at EOF"""
        fh = self.fd
        sig = fh.read( 4 )
        if not sig:
            return None # EOF
        btype = sig.decode()
        size = int.from_bytes( fh.read( 4 ), byteorder='big' ) 
        if size:
            data = fh.read( size )
        else:
            data = None

        return Blob( btype, size, data )


# Blobs recognized by this script

BlobType = namedtuple( 'BlobType', ('name', 'type') )
blobTypes = {
        'DRBT': BlobType( 'Header', None ),
        'RSPS': BlobType( 'Sample rate', int ),
        'RCHN': BlobType( 'Channels', int ),
        'RFRS': BlobType( 'Frame size', int ),
        'TIME': BlobType( 'Start time', int ),
        'GULD': BlobType( 'Server', str ),
        'CHNL': BlobType( 'Channel', str ),
        'USER': BlobType( 'User', str ),
        'DATA': BlobType( 'Audio Start', None ),
        'RPKT': BlobType( 'Packet Start', None ),
        'STMP': BlobType( 'Timestamp', int ),
        'PCM0': BlobType( 'PCM Data', bytes )
        }

def main():
    parser = ArgumentParser(
            prog='DecodeRecording',
            description='Decode a Discord RecordBot recording into audio'
            )

    parser.add_argument( 'input', type=Path,
                        help="Input recording file" )
    parser.add_argument( 'output', type=Path, nargs='?',
                        help="Output file. Default is input file " +
                        "with a .wav extension" )
    parser.add_argument( '-S', '--no-silence', action='store_true',
                        help="Don't reconstruct silences" )

    args = parser.parse_args()
    if not args.output:
        args.output = args.input.with_suffix( '.wav' )

    with BlobFile.open( args.input, 'rb' ) as fin:
        with wave.open( str( args.output ), 'wb' ) as fout:
            translate( fin, fout, args.no_silence )

def translate( fin, fout, nopad=False ):
    header = {}
    while True:
        blob = fin.next()
        if not blob: break
        if blob.sig == 'DATA':
            break
        header[blob.sig] = blob
        if blob.sig in blobTypes:
            (name, btype) = blobTypes[blob.sig]
            if btype is None:
                print( name )
            elif btype is str:
                print( f"{name}: {blob.data.decode()}" )
            elif btype is int:
                print( f"{name}: {int( blob )}" )
            elif btype is bytes:
                print( f"{name}: Binary data of size {blob.size}" )
            else:
                print( f"{name} of size {blob.size} of unknown type" )
        else:
            print( f"Read {blob.sig} of size {blob.size}" )
    # Data starts here
    stamp = None
    data = None
    done = False
    written = 0
    rate = int( header['RSPS'] )
    channels = int( header['RCHN'] )
    ssize = channels * 2 # Number of channels times 16-bit samples

    fout.setnchannels( channels )
    fout.setsampwidth( 2 )
    fout.setframerate( rate )

    print( "DATA START" )
    # print( f"Sample rate: {rate}" )
    # print( f"Channels: {channels}" )
    # print( f"Sample size: {ssize}" )

    while True:
        blob = fin.next()
        if not blob: break

        if blob.sig == 'RPKT':
            stamp = None
            data = None
            done = False
        elif blob.sig == 'STMP':
            stamp = int( blob )
        elif blob.sig == 'PCM0':
            data = blob.data
        if stamp and data and not done:
            # print( f"Data of size {blob.size} at time {stamp}" )
            expected = floor( stamp * rate * ssize / 1000 )
            msg = f"Expected {expected}, written {written}"
            excess = expected - written
            excess -= excess % ssize
            # TODO: Configurable silence threshold
            if excess > 0:
                msg += f"; padded {excess}"
                if not nopad: fout.writeframesraw( bytes( [0] ) * excess )
                written += excess
            written += blob.size
            msg += f"; writing {blob.size}"
            fout.writeframesraw( blob.data )
            done = True
            # print( msg )

    print( "Done" )



if __name__ == "__main__":
    main()
