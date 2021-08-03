import { GlCanvas } from './gl-canvas.js';
import { HLS } from './hls.js';
import shader from './greyscale-shader.js';

const ingestion_url_el = document.getElementById('ingestion-url');
ingestion_url_el.value = localStorage.getItem('streamana-example-ingestion-url');

const go_live_el = document.getElementById('go-live');
go_live_el.disabled = false;
go_live_el.addEventListener('click', function () {
    if (this.checked) {
        start();
    } else {
        stop();
    }
});

let canvas_el = document.getElementById('canvas');
const canvas_proto = canvas_el.cloneNode();
const waiting_el = document.getElementById('waiting');
const error_alert_el = document.getElementById('error-alert');
const error_alert_el_parent = error_alert_el.parentNode;
const error_alert_el_nextSibling = error_alert_el.nextSibling;
error_alert_el_parent.removeChild(error_alert_el);

const ffmpeg_lib_url_el = document.getElementById('ffmpeg-lib-url');
const initial_ffmpeg_lib_url = (localStorage.getItem('streamana-ffmpeg-lib-url') || '').trim();
if (initial_ffmpeg_lib_url) {
    ffmpeg_lib_url_el.value = initial_ffmpeg_lib_url;
}
ffmpeg_lib_url_el.addEventListener('input', function () {
    localStorage.setItem('streamana-ffmpeg-lib-url', this.value);
});

const zoom_portrait_el = document.getElementById('zoom-portrait');
zoom_portrait_el.checked = !!localStorage.getItem('streamana-zoom-portrait');
zoom_portrait_el.addEventListener('input', function () {
    localStorage.setItem('streamana-zoom-portrait', this.checked ? 'true' : '');
});

const lock_portrait_el = document.getElementById('lock-portrait');
lock_portrait_el.checked = !!localStorage.getItem('streamana-lock-portrait');
zoom_portrait_el.disabled = lock_portrait_el.checked;
lock_portrait_el.addEventListener('input', function () {
    localStorage.setItem('streamana-lock-portrait', this.checked ? 'true' : '');
    zoom_portrait_el.disabled = this.checked;
});

let hls;

async function start() {
    const ingestion_url = ingestion_url_el.value.trim();
    if (!ingestion_url) {
        go_live_el.checked = false;
        return;
    }
    localStorage.setItem('streamana-example-ingestion-url', ingestion_url);

    const ffmpeg_lib_url = ffmpeg_lib_url_el.value.trim() ||
                           ffmpeg_lib_url_el.placeholder.trim();

    go_live_el.disabled = true;
    ingestion_url_el.disabled = true;
    ingestion_url_el.parentNode.classList.add('d-none');
    ffmpeg_lib_url_el.disabled = true;
    lock_portrait_el.disabled = true;
    zoom_portrait_el.disabled = true;
    waiting_el.classList.remove('d-none');

    const canvas_el_parent = canvas_el.parentNode;
    canvas_el_parent.removeChild(canvas_el);
    canvas_el = canvas_proto.cloneNode();
    canvas_el.classList.add('invisible');
    canvas_el_parent.appendChild(canvas_el);

    if (error_alert_el.parentNode) {
        error_alert_el_parent.removeChild(error_alert_el);
    }

    let camera_stream, gl_canvas, canvas_stream, lock_portrait = false, done = false;
    function cleanup(err) {
        if (err) {
            console.error(err);
        }
        if (done) {
            return;
        }
        done = true;
        canvas_el_parent.classList.add('mx-auto');
        if (lock_portrait) {
            screen.orientation.unlock();
            if (document.fullscreenElement) {
                document.exitFullscreen();
            }
        }
        if (err) {
            error_alert_el_parent.insertBefore(error_alert_el, error_alert_el_nextSibling);
            error_alert_el.classList.add('show');
        }
        if (camera_stream) {
            for (let track of camera_stream.getTracks()) {
                track.stop();
            }
        }
        if (gl_canvas) {
            gl_canvas.destroy();
        }
        if (canvas_stream) {
            for (let track of canvas_stream.getTracks()) {
                track.stop();
            }
        }
        if (hls) {
            hls.end(!!err);
        }
        go_live_el.checked = false;
        go_live_el.disabled = false;
        ingestion_url_el.disabled = false;
        ingestion_url_el.parentNode.classList.remove('d-none');
        ffmpeg_lib_url_el.disabled = false;
        lock_portrait_el.disabled = false;
        zoom_portrait_el.disabled = lock_portrait_el.checked;
        waiting_el.classList.add('d-none');
        canvas_el.classList.add('d-none');
    }

    try {
        // create video element which will be used for grabbing the frames to
        // write to a canvas so we can apply webgl shaders
        // also used to get the native video dimensions
        const video_el = document.createElement('video');
        video_el.muted = true;
        video_el.playsInline = true;

        // Safari on iOS requires us to play() in the click handler and doesn't
        // track async calls. So we play a blank video first. After that, the video
        // element is blessed for script-driven playback.
        video_el.src = 'empty.mp4';
        await video_el.play();

        // capture video from webcam
        const video_constraints = {
            //width: 4096,
            //height: 2160,
            width: 1280,
            height: 720,
            //width: 800,
            //height: 600,
            frameRate: {
                ideal: 30,
                max: 30
            }
        };
        try {
            camera_stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: video_constraints
            });
        } catch (ex) {
            // retry in case audio isn't available
            console.warn("Failed to get user media, retrying without audio");
            camera_stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: video_constraints
            });
        }

        canvas_el.addEventListener('webglcontextlost', cleanup);

        // use glsl-canvas to make managing webgl stuff easier
        // because it's not visible, client dimensions are zero so we
        // need to substitute actual dimensions instead
        gl_canvas = new GlCanvas(canvas_el, {
            // as an example, greyscale the stream
            fragmentString: shader
        });

        gl_canvas.on('error', cleanup);

        // tell canvas to use frames from video
        gl_canvas.setTexture('u_texture', video_el);

        // wait for video to load (must come after gl_canvas.setTexture() since it
        // registers a loadeddata handler which then registers a play handler)
        video_el.addEventListener('loadeddata', async function () {
            try {
                console.log(`video width=${this.videoWidth} height=${this.videoHeight}`);
                // make canvas same size as native video dimensions so every pixel is seen
                const portrait = this.videoWidth < this.videoHeight;
                let zoom_portrait = false;
                if (portrait) {
                    if (lock_portrait_el.checked) {
                        lock_portrait = true;
                        canvas_el.classList.add('rotate');
                        canvas_el.classList.remove('mw-100', 'mh-100');
                        canvas_el_parent.classList.remove('mx-auto');
                        try {
                            await screen.orientation.lock('portrait');
                        } catch (ex) {
                            if (ex.name === 'SecurityError') {
                                if (!document.fullscreenElement) {
                                    await document.documentElement.requestFullscreen();
                                }
                                await screen.orientation.lock('portrait');
                            } else if (ex.name !== 'NotSupportedError') {
                                throw ex;
                            }
                        }
                    } else if (zoom_portrait_el.checked) {
                        zoom_portrait = true;
                        canvas_el.classList.add('zoom');
                        canvas_el.classList.remove('mw-100', 'mh-100');
                        canvas_el_parent.classList.remove('mx-auto');
                    }
                    canvas_el.width = this.videoHeight;
                    canvas_el.height = this.videoWidth;
                } else {
                    canvas_el.width = this.videoWidth;
                    canvas_el.height = this.videoHeight;
                }
                gl_canvas.setUniform('u_rotate', lock_portrait);
                const ar_canvas = lock_portrait || zoom_portrait ?
                        canvas_el.height / canvas_el.width :
                        canvas_el.width / canvas_el.height;

                // start the camera video
                this.play();

                // capture video from the canvas
                // Note: Safari on iOS doesn't get any data, might be related to
                // https://bugs.webkit.org/show_bug.cgi?id=181663
                const frame_rate = camera_stream.getVideoTracks()[0].getSettings().frameRate;
                canvas_stream = canvas_el.captureStream(frame_rate);

                // add audio if present
                const audio_tracks = camera_stream.getAudioTracks();
                if (audio_tracks.length > 0) {
                    canvas_stream.addTrack(audio_tracks[0]);
                }

                function update() {
                    // update the canvas
                    if (gl_canvas.onLoop()) {
                        // Note: we need to use canvas_el_parent.parentNode.offsetWidth
                        // to take into account margins
                        const ar_parent = canvas_el_parent.parentNode.offsetWidth /
                                          canvas_el_parent.offsetHeight;
                        if (lock_portrait) {
                            if (ar_parent >= ar_canvas) {
                                canvas_el.style.width = `${canvas_el_parent.offsetHeight}px`;
                                canvas_el.style.height = `${canvas_el_parent.offsetHeight * ar_canvas}px`;
                            } else {
                                canvas_el.style.width = `${canvas_el_parent.parentNode.offsetWidth / ar_canvas}px`;
                                canvas_el.style.height = `${canvas_el_parent.parentNode.offsetWidth}px`;
                            }
                        } else if (zoom_portrait) {
                            if (ar_parent >= ar_canvas) {
                                // canvas_el.style.width = canvas_el_parent.offsetHeight * (1 / ar_canvas);  =>
                                canvas_el.style.width = `${canvas_el_parent.offsetHeight / ar_canvas}px`;
                                canvas_el.style.height = `${canvas_el_parent.offsetHeight}px`;
                            } else {
                                // canvas_el.style.width = canvas_el_parent.parentNode.offsetWidth / (canvas_el.height * ar_canvas / canvas_el.width);  =>
                                // canvas_el.style.width = canvas_el_parent.parentNode.offsetWidth * canvas_el.width / (canvas_el.height * ar_canvas)  =>
                                // canvas_el.style.width = canvas_el_parent.parentNode.offsetWidth * (canvas_el.width / canvas_el.height) / ar_canvas  =>
                                // canvas_el.style.width = canvas_el_parent.parentNode.offsetWidth * (1 / ar_canvas) / ar_canvas  =>
                                canvas_el.style.width = `${canvas_el_parent.parentNode.offsetWidth / ar_canvas ** 2}px`;
                                // canvas_el.style.height = canvas_el_parent.parentNode.offsetWidth / (1 / ar_canvas); =>
                                canvas_el.style.height = `${canvas_el_parent.parentNode.offsetWidth * ar_canvas}px`;
                            }
                        } else if (ar_parent >= ar_canvas) {
                            canvas_el.style.width = `${canvas_el_parent.offsetHeight * ar_canvas}px`;
                            canvas_el.style.height = `${canvas_el_parent.offsetHeight}px`;
                        } else {
                            canvas_el.style.width = `${canvas_el_parent.parentNode.offsetWidth}px`;
                            canvas_el.style.height = `${canvas_el_parent.parentNode.offsetWidth / ar_canvas}px`;
                        }
                        // TODO:
                        // a40 no buffers currently available in the reader queue
                        // we need to detect what resolutions encoder will support
                        //   and either capture at that resolution or can canvas downscale?
                        // windows, android, iOS, find a mac to test
                        // check behaviour when rotate phone
                    }
                }

                // start HLS from the canvas stream to the ingestion URL
                hls = new HLS(canvas_stream, ingestion_url, ffmpeg_lib_url, frame_rate, lock_portrait);
                hls.addEventListener('run', () => console.log('HLS running'));
                hls.addEventListener('exit', ev => {
                    const msg = `HLS exited with status ${ev.detail.code}`;
                    if (ev.detail.code === 0) {
                        console.log(msg);
                        cleanup();
                    } else {
                        cleanup(msg);
                    }
                });
                hls.addEventListener('error', cleanup);
                hls.addEventListener('start', function () {
                    if (done) {
                        this.end(true);
                    }
                    waiting_el.classList.add('d-none');
                    canvas_el.classList.remove('invisible');
                    go_live_el.disabled = false;
                    update();
                });
                hls.addEventListener('update', update);
                await hls.start();
            } catch (ex) {
                cleanup(ex);
            }
        });

        // pass the stream from the camera to the video so it can render the frames
        video_el.srcObject = camera_stream;
    } catch (ex) {
        return cleanup(ex);
    }
}

function stop() {
    go_live_el.disabled = true;
    hls.end();
}
