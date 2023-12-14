const credential = {
    region: 'us-west-2',
    accessKeyId: 'AKIAQM47F6JFTJO4UUV2',
    secretAccessKey: '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'
}

let transcript = []; // list of finalized transcript
let transcriptBoxs = []; // list of boxed transcript words
let segments = [];
let entities = [];
let partialTranscript = ""; // last chunk of transcript, which has not be finalized

/**
 * Get access to the users microphone through the browser.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#Using_the_new_API_in_older_browsers
 */
function getMicAudioStream() {
    // Older browsers might not implement mediaDevices at all, so we set an empty object first
    if (navigator.mediaDevices === undefined) {
        navigator.mediaDevices = {};
    }
    // Some browsers partially implement mediaDevices. We can't just assign an object
    // with getUserMedia as it would overwrite existing properties.
    // Here, we will just add the getUserMedia property if it's missing.
    if (navigator.mediaDevices.getUserMedia === undefined) {
        navigator.mediaDevices.getUserMedia = function(constraints) {
            // First get ahold of the legacy getUserMedia, if present
            var getUserMedia =
              navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
            // Some browsers just don't implement it - return a rejected promise with an error
            // to keep a consistent interface
            if (!getUserMedia) {
                return Promise.reject(
                  new Error('getUserMedia is not implemented in this browser')
                );
            }
            // Otherwise, wrap the call to the old navigator.getUserMedia with a Promise
            return new Promise(function(resolve, reject) {
                getUserMedia.call(navigator, constraints, resolve, reject);
            });
        };
    }
    const params = { audio: true, video: false };
    return navigator.mediaDevices.getUserMedia(params);
}

// our global variables for managing state
let languageCode;
let region;
let sampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;

export function streamAudioToWebSocket(userMediaStream, onTranscript, onError) {
    //let's get the mic input from the browser, via the microphone-stream module
    console.log("Start new stream");
    micStream = new mic();
    micStream.setStream(userMediaStream);

    // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    let url = createPresignedUrl();

    //open up our WebSocket connection
    try {
        let websocket = new WebSocket(url);
        websocket.binaryType = "arraybuffer";

        // when we get audio data from the mic, send it to the WebSocket if possible
        websocket.onopen = function () {
            micStream.on('data', function (rawAudioChunk) {
                  // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
                  let binary = convertAudioToBinaryMessage(rawAudioChunk);

                  if (socket.OPEN)
                      socket.send(binary);
              }
            )
        };

        // handle messages, errors, and close events
        // handle inbound messages from Amazon Transcribe
        websocket.onmessage = function (message) {
            //convert the binary event stream message to JSON
            let messageWrapper = eventStreamMarshaller.unmarshall(Buffer(message.data));
            let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
            if (messageWrapper.headers[":message-type"].value === "event") {
                let results = messageBody.Transcript.Results;

                if (results.length > 0) {
                    if (results[0].Alternatives.length > 0) {
                        let transcript = results[0].Alternatives[0].Transcript;

                        // fix encoding for accented characters
                        transcript = decodeURIComponent(escape(transcript));
                        console.log("get transcript: " + transcript);



                        // update the textarea with the latest result
                        // $('#transcript').val(transcription + transcript + "\n");
                        onTranscript({
                            results: results,
                            text: transcript,
                            isPartial: results[0].IsPartial
                        });

                    }
                }
                // handleEventStreamMessage(messageBody);
            }
            else {
                transcribeException = true;
                showError(messageBody.Message);
                // toggleStartStop();
            }
        };

        websocket.onerror = function () {
            socketError = true;
            console.log("Websocket connection error");
            showError('WebSocket connection error. Try again.');
            // toggleStartStop();
        };

        websocket.onclose = function (closeEvent) {
            micStream.stop();

            console.log("Websocket connection error:" + JSON.stringify(closeEvent));
            console.log("Websocket connection error:" + closeEvent.reason);
            // the close event immediately follows the error event; only handle one.
            if (!socketError && !transcribeException) {
                if (closeEvent.code != 1000) {
                    showError('</i><strong>Streaming Exception</strong><br>' + closeEvent.reason);
                }
                toggleStartStop();
            }
        };

        socket = websocket;
    } catch (error) {
        console.log(error);
    }
}


function createPresignedURLUtils(method, host, path, service, payload, options) {
    options = options || {};
    options.key = options.key || process.env.AWS_ACCESS_KEY_ID;
    options.secret = options.secret || process.env.AWS_SECRET_ACCESS_KEY;
    options.protocol = options.protocol || 'https';
    options.headers = options.headers || {};
    options.timestamp = options.timestamp || Date.now();
    options.region = options.region || process.env.AWS_REGION || 'us-east-1';
    options.expires = options.expires || 86400; // 24 hours
    options.headers = options.headers || {};

    // host is required
    options.headers.Host = host;

    var query = options.query ? querystring.parse(options.query) : {};
    query['X-Amz-Algorithm'] = 'AWS4-HMAC-SHA256';
    query['X-Amz-Credential'] = options.key + '/' + exports.createCredentialScope(options.timestamp, options.region, service);
    query['X-Amz-Date'] = toTime(options.timestamp);
    query['X-Amz-Expires'] = options.expires;
    query['X-Amz-SignedHeaders'] = exports.createSignedHeaders(options.headers);
    if (options.sessionToken) {
        query['X-Amz-Security-Token'] = options.sessionToken;
    }

    var canonicalRequest = exports.createCanonicalRequest(method, path, query, options.headers, payload);
    var stringToSign = exports.createStringToSign(options.timestamp, options.region, service, canonicalRequest);
    var signature = exports.createSignature(options.secret, options.timestamp, options.region, service, stringToSign);
    query['X-Amz-Signature'] = signature;
    return options.protocol + '://' + host + path + '?' + querystring.stringify(query);
};

function createPresignedUrl() {
    let endpoint = `transcribestreaming.${credential.region}.amazonaws.com:8443`;

    // get a preauthenticated URL that we can use to establish our WebSocket
    return createPresignedURLUtils(
      'GET',
      endpoint,
      '/medical-stream-transcription-websocket',
      'transcribe',
      crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
          'key': credential.accessKeyId,
          'secret': credential.secretAccessKey,
          // 'sessionToken': $('#session_token').val(),
          'protocol': 'wss',
          'expires': 60,
          'region': credential.region,
          'query': "language-code=en-US&media-encoding=pcm&sample-rate=16000&specialty=PRIMARYCARE&type=DICTATION"
      }
    );
}

function startRecord() {
    getMicAudioStream()
      .then((stream) => {
          window.localStream = stream;
          return stream;
      }).then(micAudioStream => {
          console.log(`Browser support microphone audio input`);

          // Start Streaming websocket connection
          streamAudioToWebSocket(micAudioStream, updateTranscript, (error) => {
              console.log(error)
          });

          return micAudioStream;
      }).catch(err => {
          // Users browser doesn't support audio.
          // Add your handler here.
          console.log(err);
      })
}

function stopRecord() {

}

function clearTranscript() {

}
