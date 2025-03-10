/*!
 * Simple library to send files over WebRTC
 *
 * @author   Subin Siby <https://subinsb.com>
 * @license  MPL-2.0
 */

import * as Peer from 'simple-peer'
import PeerFileSend from './PeerFileSend'
import PeerFileReceive from './PeerFileReceive'

export default class SimplePeerFiles {
  private arrivals: {
    [fileID: string]: PeerFileReceive
  } = {}

  send (peer: Peer.Instance, fileID: string, file: File) {
    return new Promise(resolve => {
      const controlChannel = peer

      let startingByte = 0



      const fileChannel = new Peer({
        initiator: true,
        // @ts-ignore the config exists on peer but is not exposed.
        config: peer.config
      })

      fileChannel.on('signal', (signal: Peer.SignalData) => {
        controlChannel.send(JSON.stringify({
          fileID,
          signal
        }))
      })

      let controlDataHandler = (data: string) => {
        try {
          const dataJSON = JSON.parse(data)

          if (dataJSON.signal && dataJSON.fileID && dataJSON.fileID === fileID) {
            if (dataJSON.start) {
              startingByte = dataJSON.start
            }

            fileChannel.signal(dataJSON.signal)
          }
        } catch (e) {}
      }

      fileChannel.on('connect', () => {
        let pfs = new PeerFileSend(fileChannel, file, startingByte)

        let destroyed = false
        const destroy = () => {
          if (destroyed) return

          controlChannel.removeListener('data', controlDataHandler)

          // garbage collect
          controlDataHandler = null
          // Set pfs at null before destroy to avoid call to cancel on fileChannel close.
          pfs = null

          fileChannel.destroy()

          destroyed = true
        }

        pfs.on('done', destroy)
        pfs.on('cancel', destroy)

        fileChannel.on('close', () => {
          if (pfs) {
            pfs.cancel();
          }
        })

        resolve(pfs)
      })
      controlChannel.on('data', controlDataHandler)
    })
  }

  receive (peer: Peer.Instance, fileID: string, writer) {
    return new Promise(resolve => {
      const controlChannel = peer

      const fileChannel = new Peer({
        initiator: false,
        // @ts-ignore the config exists on peer but is not exposed.
        config: peer.config
      })

      fileChannel.on('signal', (signal: Peer.SignalData) => {
        // chunk to start sending from
        let start = 0

        // File resume capability
        if (fileID in this.arrivals) {
          // @ts-ignore
          start = this.arrivals[fileID].bytesReceived
        }

        controlChannel.send(JSON.stringify({
          fileID,
          start,
          signal
        }))
      })

      let controlDataHandler = (data: string) => {
        try {
          const dataJSON = JSON.parse(data)

          if (dataJSON.signal && dataJSON.fileID && dataJSON.fileID === fileID) {
            fileChannel.signal(dataJSON.signal)
          }
        } catch (e) {}
      }

      fileChannel.on('connect', () => {
        let pfs: PeerFileReceive

        if (fileID in this.arrivals) {
          pfs = this.arrivals[fileID]
          pfs.setPeer(fileChannel)
        } else {
          pfs = new PeerFileReceive(fileChannel, writer)
          this.arrivals[fileID] = pfs
        }

        let destroyed = false
        const destroy = () => {
          if (destroyed) return

          controlChannel.removeListener('data', controlDataHandler)

          // garbage collect
          controlDataHandler = null
          pfs = null

          fileChannel.destroy()
          delete this.arrivals[fileID]

          destroyed = true
        }

        pfs.on('cancel', destroy)
        fileChannel.on('close', destroy);

        resolve(pfs)
      })
      controlChannel.on('data', controlDataHandler)
    })
  }
}

export { PeerFileSend, PeerFileReceive }
