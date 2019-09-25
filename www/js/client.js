var socket = io();
var localStreams = {};
var localPc = null;
var myself = null;
var conferenceId = null;
var conferencePassword = null;

function joinConference() {
  if (conferenceId) return;
  conferenceId = document.getElementById('conferenceId').value;
  conferencePassword = document.getElementById('password').value;
  if (conferenceId) {
    socket.emit('joinConference', conferenceId, conferencePassword);
  }
}

function kickMember(memberUuid) {
  socket.emit('kickMember', memberUuid);
}

function addStream() {
  navigator.mediaDevices.getDisplayMedia()
    .then(function(mediaStream) {
      var stream = { name: "screen", mediaStream: mediaStream  };
      localStreams[stream.name] = stream;
      socket.emit('publishStream', stream.name, true, true);
      mediaStream.oninactive = function() {
        socket.emit('unpublishStream', stream);
        delete localStreams[stream.name];
      }
    })
    .catch(function(error) {
      console.log(error);
    })
}

function addStreamVideoElement(stream) {
  var video = document.createElement('video');
  video.setAttribute('autoplay', 'autoplay');
  document.body.append(video);
  video.setAttribute('id', stream.uuid);
}

function removeStreamVideoElement(stream) {
  var video = document.getElementById(stream.uuid);
  document.body.removeChild(video);
}

socket.on('connect', function() {

  socket.on('memberJoined', function(member) {
    console.log('memberJoined', member);
  })

  socket.on('memberLeft', function(member) {
    console.log('memberLeft', member);
    if (myself.uuid == member.uuid) {
      document.location.reload();
    }
  })

  socket.on('memberList', function(members, member) {
    // list of conference members (including ourself)
    myself = member;
    navigator.getUserMedia(
      { audio: true, video: true },
      function getUserMediaSuccess(stream) {
        var cameraStream = { name: "camera", mediaStream: stream };
	localStreams[cameraStream.name] = cameraStream;
        socket.emit('publishStream', cameraStream.name, true, true);
      },
      function getUserMediaError(error) {
        console.log(error);
      }
    );
    var keys = Object.keys(members);
    keys.forEach(function(memberUuid) {
      if (memberUuid != myself.uuid) {
        if (myself.moderator || members[memberUuid].moderator) {
          Object.keys(members[memberUuid].streams).forEach(function(streamUuid) {
            var stream = members[memberUuid].streams[streamUuid];
            addStreamVideoElement(stream);
            socket.emit('subscribeStream', stream, true, true);
          });
        }
      }
    });
  })

  socket.on('publishSdpRequest', function(sdp, stream) {
    // the backend sent a SDP offer for publishing our local stream
    localPc = new RTCPeerConnection();
    localPc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: sdp }),
      function setRemoteOk() {
        var localStream = localStreams[stream.name];
        localPc.addStream(localStream.mediaStream);
        localPc.createAnswer(
          function createAnswerOk(description) {
            localPc.setLocalDescription(description,
              function setLocalOk() {
                socket.emit('publishSdpResponse', description.sdp, stream.rxRtpEndpointId, stream.uuid);
              },
              function setLocalError(error) {
                console.log(error);
              }
            )
          },
          function createAnswerError(error) {
            console.log(error);
          }
        );
      },
      function setRemoteError(error) {
        console.log(error);
      }
    );
  })

  socket.on('subscribeSdpRequest', function(sdp, endpointId, stream) {
    // the backend sent a SDP offer for receiving a remote stream
    var pc = new RTCPeerConnection();
    pc.onaddstream = function(event) {
      var video = document.getElementById(stream.uuid);
      video.srcObject = event.stream;
    };
    pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: sdp }),
      function setRemoteOk() {
        pc.createAnswer(
          function createAnswerOk(description) {
            pc.setLocalDescription(description,
              function setLocalOk() {
                socket.emit('subscribeSdpResponse', description.sdp, endpointId, stream);
              },
              function setLocalError(error) {
                console.log(error);
              }
            )
          },
          function createAnswerError(error) {
            console.log(error);
          }
        );
      },
      function setRemoteError(error) {
        console.log(error);
      }
    );
  })

  socket.on('streamStatus', function(stream, active, member) {
    // the status of a stream changed
    if (member.uuid != myself.uuid) {
      if (myself.moderator || member.moderator) {
        if (active) {
          console.log('member ' + member.uuid + ' started sending stream ' + stream.uuid);
          addStreamVideoElement(stream);
          socket.emit('subscribeStream', stream, true, true);
        } else {
          console.log('member ' + member.uuid + ' stopped sending stream ' + stream.uuid);
          removeStreamVideoElement(stream);
        }
      }
    }
  })

})