import {Duplex, Readable, Writable} from 'readable-stream'
import { EventEmitter } from 'ee-ts'
import SimplePeer from 'simple-peer'

import { ControlHeaders, FileStartMetadata } from './Meta'

interface Events {
  progress(percentage: number, bytesSent: number): void,

  done(): void

  // Called when receiver (this) has requested a pause
  pause(): void

  // Called when sender paused the transfer
  paused(): void

  // Called when receiver (this) has requested to resume
  resume(): void

  // Called when sender has requested to resume
  resumed(): void

  // Called when the receiver (this) calls cancel
  cancel(): void

  // Called when the sender cancels the transfer
  cancelled(): void

  error(reason?: string): void
}

class ReceiveStream extends Writable {
  /**
   * File stream writes here
   * @param chunk
   * @param encoding
   * @param cb
   */
  _write (data: Uint8Array, encoding: string, cb: Function) {
    if (data[0] === ControlHeaders.FILE_START) {
      const meta = JSON.parse(new TextDecoder().decode(data.slice(1))) as FileStartMetadata
      this.emit('start', meta)
    } else if (data[0] === ControlHeaders.FILE_CHUNK) {
      this.emit('chunk', data.slice(1))
    } else if (data[0] === ControlHeaders.TRANSFER_PAUSE) {
      this.emit('paused')
    } else if (data[0] === ControlHeaders.TRANSFER_RESUME) {
      this.emit('resumed')
    }

    if (data[0] === ControlHeaders.TRANSFER_CANCEL) {
      this.emit('cancelled')
      this.destroy()
    } else {
      cb(null) // Signal that we're ready for more data
    }
  }
}

export default class PeerFileReceive extends EventEmitter<Events> {
  public paused: boolean = false;
  public cancelled: boolean = false;

  public peer: SimplePeer.Instance;
  private rs: ReceiveStream;

  public fileName: string;
  public fileSize!: number; // File size in bytes
  private fileData = [];
  private fileStream: Readable = null;
  public fileType!: string;
  private writer: Duplex = null;

  private isFileTransferred = false;

  constructor (peer: SimplePeer.Instance, writer: Duplex) {
    super()
    this.writer = writer;
    this.setPeer(peer)
  }

  // When peer is changed, start a new stream handler and assign events
  setPeer (peer: SimplePeer.Instance) {
    if (this.rs) {
      this.rs.destroy()
    }

    this.rs = new ReceiveStream()
    this.peer = peer
    this.peer.on("error", err => {
      // Ignore error if file transfer is finished as we don't need the channel anymore
      if(this.isFileTransferred) {
        return;
      }
      this.emit('error', JSON.stringify(err, null, 2));
    });
    peer.pipe(this.rs)

    this.writer.on('progress', (p, bytesReceived) => {
      this.emit('progress', p, bytesReceived);
      if (p === 100.0) {
        this.isFileTransferred = true;
        this.sendPeer(ControlHeaders.FILE_END);
        this.emit('done');
      }
    });

    this.rs.on('start', meta => {
      this.fileName = meta.fileName
      this.fileSize = meta.fileSize
      this.fileType = meta.fileType
      this.fileData = []
    })
    this.rs.on('chunk', chunk => {
      this.writer.write(chunk);
    })
    this.rs.on('paused', () => {
      this.emit('paused')
    })
    this.rs.on('resumed', () => {
      this.emit('resumed')
    })
    this.rs.on('cancelled', () => {
      this.emit('cancelled')
    })
    this.rs.on('finish', chunk => {
      this.writer.end()
    })
  }

  /**
   * Send a message to sender
   * @param header Type of message
   * @param data   Message
   */
  private sendPeer (header: number, data: Uint8Array = null) {
    if (!this.peer.connected) return

    let resp: Uint8Array
    if (data) {
      resp = new Uint8Array(1 + data.length)
      resp.set(data, 1)
    } else {
      resp = new Uint8Array(1)
    }
    resp[0] = header

    this.peer.send(resp)
  }

  // Create a stream for receiving file data
  createReadStream () {
    this.fileStream = new Readable({
      objectMode: true,
      read () {} // We'll be using push when we have file chunk
    })
    return this.fileStream
  }

  // Request sender to pause transfer
  pause () {
    this.sendPeer(ControlHeaders.TRANSFER_PAUSE)
    this.paused = true
    this.emit('pause')
  }

  // Request sender to resume sending file
  resume () {
    this.sendPeer(ControlHeaders.TRANSFER_RESUME)
    this.paused = false
    this.emit('resume')
  }

  cancel () {
    this.cancelled = true
    this.sendPeer(ControlHeaders.TRANSFER_CANCEL)

    this.fileData = []
    this.rs.destroy()
    this.peer.destroy()

    if (this.fileStream) this.fileStream.destroy()

    this.emit('cancel')
  }
}
