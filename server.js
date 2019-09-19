const config = require('./config');
const zmq = require('zeromq');
const Uuid = require('node-uuid');
const app = require('express')();
const WebSocket = require('ws');
const http = require('http').createServer(app);
const conferences = config.conferences;
const ahoymedCallbacks = {};

app.get('/', function(req, res){
  res.send('<h1>Hello world</h1>');
})

http.listen(config.socketIo.port, function(){
  console.log('listening on *:' + config.socketIo.port);
})

const io = require('socket.io')(http);


function destroyRtpEndpoint(endpointId) {
  var uuid = Uuid.v4();
  var message = {
    destroyRtpEndpointRequest: {
      id: endpointId,
      uuid: uuid
    }
  };
  console.log('request: ' + JSON.stringify(message));
  ahoymedCallbacks[uuid] = function(response) {
    console.log('ahoymed response', response);
  };
  ahoymedSocket.send(JSON.stringify(message));
}

io.on('connection', function(socket){
  const member = { uuid: Uuid.v4(), audio: false, video: false, moderator: false, streams: {} };

  socket.on('joinConference', function(conferenceId, password) {
    if (conferences[conferenceId]) {
      const conference = conferences[conferenceId];
      if (conference.moderatorPassword == password) {
        member.moderator = true;
      }
      console.log('joinConference: password ' + password + ' moderatorPassword ' + conference.moderatorPassword);
      if (!conference.members) {
        conference.members = {};
      }
      member.conferenceId = conferenceId;
      conference.members[member.uuid] = member;
      console.log('member ' + member.uuid + ' joined conference ' + conferenceId + ', now ' + Object.keys(conference.members).length + ' members');
      socket.emit('memberList', conference.members, member);
      io.to('conference_' + conferenceId).emit('memberJoined', member);
      socket.join('conference_' + conferenceId);
    }
  })

  socket.on('stopMedia', function(stream) {
    const conference = conferences[member.conferenceId];
    if (conference) {
      Object.keys(member.streams).forEach(function(streamUuid) {
        if (member.streams[streamUuid].name == stream.name) {
          destroyRtpEndpoint(member.streams[streamUuid].rxRtpEndpointId);
          io.to('conference_' + member.conferenceId).emit('memberMediaStatus', member, member.streams[streamUuid], false);
        }
      });
    }
  });

  socket.on('startMedia', function(name, audio, video) {
    const conference = conferences[member.conferenceId];
    if (conference) {
      const stream = { name: name, audio: audio, video: video, uuid: Uuid.v4() };
      if (audio || video) {
        // create a RTP endpoint to receive audio/video from the client
        var uuid = Uuid.v4();
        var message = {
          createRtpEndpointRequest: {
          apiContext: "conference_" + member.conferenceId,
          localDescription: {
            type: "create",
            sdp: config.sdp.transmitAudioVideo
          },
          decodeAudio: false,
          transparentRtcp: true,
          rtcpCheating: config.sdp.rtcpCheating,
          loopback: false,
          pcap: false,
          uuid: uuid
         }
        };
        console.log('request: ' + JSON.stringify(message));
        ahoymedCallbacks[uuid] = function(response) {
          console.log('ahoymed response', response);
          if (response && response.createRtpEndpointResponse && response.createRtpEndpointResponse.rtpEndpoint) {
            stream.rxRtpEndpointId = response.createRtpEndpointResponse.rtpEndpoint.id;
            member.streams[stream.uuid] = stream;
            socket.emit('transmitSdpRequest', response.createRtpEndpointResponse.rtpEndpoint.localDescription.sdp, stream);
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })
  
  socket.on('receiveMedia', function(stream, audio, video) {
    const conference = conferences[member.conferenceId];
    if (conference) {
      // create a RTP endpoint to transmit audio/video to the client
      var uuid = Uuid.v4();
      var message = {
        createRtpEndpointRequest: {
          apiContext: "conference_" + member.conferenceId,
          localDescription: {
            type: "create",
            sdp: config.sdp.receiveAudioVideo
          },
          decodeAudio: false,
          transparentRtcp: true,
          loopback: false,
          pcap: false,
          uuid: uuid
        }
      };
      console.log('request: ' + JSON.stringify(message));
      ahoymedCallbacks[uuid] = function(response) {
        console.log('ahoymed response', response);
        if (response && response.createRtpEndpointResponse && response.createRtpEndpointResponse.rtpEndpoint) {
          var txRtpEndpointId = response.createRtpEndpointResponse.rtpEndpoint.id;
          socket.emit('receiveSdpRequest', response.createRtpEndpointResponse.rtpEndpoint.localDescription.sdp, txRtpEndpointId, stream);
        }
      };
      ahoymedSocket.send(JSON.stringify(message));
    }
  })
  
  socket.on('transmitSdpResponse', function(sdp, endpointId, streamUuid) {
    if (member.conferenceId) {
      if (sdp) {
        var stream = member.streams[streamUuid];
        var uuid = Uuid.v4();
        var message = {
          updateRtpEndpointRequest: {
          id: endpointId,
          apiContext: "conference_" + member.conferenceId,
          remoteDescription: {
            type: "answer",
            sdp: sdp
          },
          uuid: uuid
         }
        };
        console.log('request: ' + JSON.stringify(message));
        ahoymedCallbacks[uuid] = function(response) {
          console.log('ahoymed response', response);
          if (response && response.updateRtpEndpointResponse && response.updateRtpEndpointResponse.success) {
            io.to('conference_' + member.conferenceId).emit('memberMediaStatus', member, stream, true);
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })

  socket.on('receiveSdpResponse', function(sdp, endpointId, stream) {
console.log('stream', stream);
    if (member.conferenceId) {
      if (sdp) {
        var uuid = Uuid.v4();
        var message = {
          updateRtpEndpointRequest: {
          id: endpointId,
          apiContext: "conference_" + member.conferenceId,
          remoteDescription: {
            type: "answer",
            sdp: sdp
          },
          sourceId: stream.rxRtpEndpointId,
          uuid: uuid
         }
        };
        console.log('request: ' + JSON.stringify(message));
        ahoymedCallbacks[uuid] = function(response) {
          console.log('ahoymed response', response);
          if (response && response.updateRtpEndpointResponse && response.updateRtpEndpointResponse.success) {
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })
  
  socket.on('kickMember', function(memberUuid) {
    if (member.moderator) {
      const conference = conferences[member.conferenceId];
      if (conference) {
        if (conference.members[memberUuid]) {
          Object.keys(conference.members[memberUuid].streams).forEach(function(streamUuid) {
            var stream = conference.members[memberUuid].streams[streamUuid];
            io.to('conference_' + member.conferenceId).emit('memberMediaStatus', conference.members[memberUuid], stream, false);
            destroyRtpEndpoint(stream.rxRtpEndpointId);
          });
          io.to('conference_' + member.conferenceId).emit('memberLeft', conference.members[memberUuid]);
          conference.members[memberUuid].conferenceId = null;
        }
      }
    }
  })

  socket.on('disconnect', function() {
    if (member.conferenceId) {
      const conference = conferences[member.conferenceId];
      if (conference.members[member.uuid]) {
        delete conference.members[member.uuid];
      }
      console.log('member ' + member.uuid + ' left conference ' + member.conferenceId);
      io.to('conference_' + member.conferenceId).emit('memberLeft', member);
    }
  })

})

var ahoymedSocket = null;

function processAhoymedMessage(message) {
    try {
      var json = JSON.parse(message);
      var keys = Object.keys(json);

      keys.forEach(function(key) {
        if (key.toLowerCase().indexOf('response') != -1) {
          var obj = json[key];
          if (ahoymedCallbacks[obj.uuid] !== undefined) {
            var msg = {};
            msg[key] = obj;
            ahoymedCallbacks[obj.uuid](msg);
            delete ahoymedCallbacks[obj.uuid];
          }
        }
      });
    } catch (parseException) {
      console.log(parseException);
    }
}

if (config.ahoymed.zmqUri) {
  ahoymedSocket = zmq.socket('dealer');
  ahoymedSocket.connect(config.ahoymed.zmqUri);
  ahoymedSocket.on('message', function(message) {
    message = message.toString();
    processAhoymedMessage(message);
  })
} else {
  ahoymedSocket = new WebSocket(config.ahoymed.wsUri);
  ahoymedSocket.onopen = function() {
    console.log('connected to media engine');
  }
  ahoymedSocket.onmessage = function(msg) {
    processAhoymedMessage(msg.data);
  }
}

