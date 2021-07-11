export class WebMDestination extends EventTarget {
    constructor() {
        super();
        setTimeout(() => {
            this.dispatchEvent(new CustomEvent('message', { detail: {
                type: 'ready'
            }}));
        }, 0);
    }

    start({ ffmpeg_lib_url, ffmpeg_args, base_url }) {
        this.worker = new Worker(ffmpeg_lib_url);
        this.worker.onerror = this.onerror.bind(this);
        this.worker.onmessage = e => {
            const msg = e.data;
            switch (msg.type) {
                case 'ready':
                    this.worker.postMessage({
                        type: 'run',
                        arguments: [
                            '-loglevel', 'debug',
                            ...ffmpeg_args,
                            '-f', 'hls', // use hls encoder
                            '-hls_time', '2', // 2 second HLS chunks
                            '-hls_segment_type', 'mpegts', // MPEG2-TS muxer
                            '-hls_list_size', '2', // two chunks in the list at a time
                            '-hls_flags', 'split_by_time',
                            '/outbound/output.m3u8' // path to media playlist file in virtual FS,
                                                    // must be under /outbound
                        ],
                        MEMFS: [
                            { name: 'stream1' },
                            { name: 'stream2' }
                        ]
                    });
                    break;
                case 'stdout':
                    console.log(msg.data);
                    break;
                case 'stderr':
                    console.error(msg.data);
                    break;
                case 'error':
                case 'abort':
                    this.onerror(msg.data);
                    break;
                case 'start-stream':
                    this.worker.postMessage({
                        type: 'base-url',
                        data: base_url
                    });
                    this.dispatchEvent(new CustomEvent('message', { detail:  msg }));
                    break;
                case 'exit':
                    this.worker = null;
                    this.dispatchEvent(new CustomEvent('message', { detail: {
                        type: msg.type,
                        code: msg.data
                    }}));
                    this.worker.terminate();
                    break;
            }
        };
    }

    muxed_data(data, { name }) {
        if (this.worker) {
            this.worker.postMessage({
                type: 'stream-data',
                name,
                data
            }, [data]);
        }
    }

    end({ force }) {
        if (this.worker) {
            if (force) {
                this.worker.terminate();
                self.postMessage({
                    this.dispatchEvent(new CustomEvent('message', { detail: {
                        type: 'exit',
                        code: 'force-end'
                    }}));
                });
            } else {
                this.worker.postMessage({
                    type: 'stream-end'
                });
            }
            this.worker = null;
        }
    }

    onerror(e) {
        if (this.worker) {
            console.error(e);
            this.dispatchEvent(new CustomEvent('message', { detail: {
                type: 'error',
                detail: e.message
            }}));
        }
    }
}