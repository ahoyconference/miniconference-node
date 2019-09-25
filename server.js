const config = require('./config');
const zmq = require('zeromq');
const Uuid = require('node-uuid')
const express = require('express');;
const app = express();
const WebSocket = require('ws');
const http = require('http').createServer(app);
const conferences = config.conferences;
const ahoymedCallbacks = {};

app.use('/', express.static('www'));

http.listen(config.socketIo.port, function(){
  console.log('listening on *:' + config.socketIo.port);
})

const io = require('socket.io')(http);

function forEachMemberStream(member, callback) {
  var streamUuids = Object.keys(member.streams);
  streamUuids.forEach(function(streamUuid) {
    var stream = member.streams[streamUuid];
    callback(stream);
  });
}

function findStreamByEndpointId(endpointId, callback) {
  var conferenceRooms = Object.keys(conferences);
  conferenceRooms.forEach(function(conferenceRoom) {
    var conference = conferences[conferenceRoom];
    if (conference && conference.members) {
      var memberUuids = Object.keys(conference.members);
      memberUuids.forEach(function(memberUuid) {
        var member = conference.members[memberUuid];
        var streamUuids = Object.keys(member.streams);

        streamUuids.forEach(function(streamUuid) {
          var stream = member.streams[streamUuid];
          if (stream.rxRtpEndpointId == endpointId) {
            callback(member, stream);
          }
        });
      });
    }
  });
}

function destroyRtpEndpoint(endpointId) {
  var uuid = Uuid.v4();
  var message = {
    destroyRtpEndpointRequest: {
      id: endpointId,
      uuid: uuid
    }
  };
  ahoymedCallbacks[uuid] = function(response) {
    if (response.destroyRtpEndpointResponse.success) {
      console.log('endpoint ' + endpointId + ' has been destroyed');
    }
  };
  ahoymedSocket.send(JSON.stringify(message));
}

io.on('connection', function(socket){
  const member = { uuid: Uuid.v4(), audio: false, video: false, moderator: false, streams: {} };

  // the socket.io connection has been disconnected, time to clean up
  socket.on('disconnect', function() {
    if (member.conferenceId) {
      const conference = conferences[member.conferenceId];
      if (conference.members[member.uuid]) {
        delete conference.members[member.uuid];
      }
      forEachMemberStream(member, function(stream) {
        if (stream.rxRtpEndpointId) {
          destroyRtpEndpoint(stream.rxRtpEndpointId);
        }
        io.to('conference_' + member.conferenceId).emit('streamStatus', stream, false, member);
      });
      member.streams = {};
      console.log('member ' + member.uuid + ' left conference ' + member.conferenceId);
      io.to('conference_' + member.conferenceId).emit('memberLeft', member);
    }
  })

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

  socket.on('kickMember', function(memberUuid) {
    if (member.moderator) {
      const conference = conferences[member.conferenceId];
      if (conference) {
        if (conference.members[memberUuid]) {
          Object.keys(conference.members[memberUuid].streams).forEach(function(streamUuid) {
            var stream = conference.members[memberUuid].streams[streamUuid];
            io.to('conference_' + member.conferenceId).emit('streamStatus', stream, false, conference.members[memberUuid]);
            destroyRtpEndpoint(stream.rxRtpEndpointId);
          });
          io.to('conference_' + member.conferenceId).emit('memberLeft', conference.members[memberUuid]);
          conference.members[memberUuid].conferenceId = null;
        }
      }
    }
  })

  // a client wants to start streaming its local media
  socket.on('publishStream', function(name, audio, video) {
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
        ahoymedCallbacks[uuid] = function(response) {
          if (response && response.createRtpEndpointResponse && response.createRtpEndpointResponse.rtpEndpoint) {
            stream.rxRtpEndpointId = response.createRtpEndpointResponse.rtpEndpoint.id;
            member.streams[stream.uuid] = stream;
            socket.emit('publishSdpRequest', response.createRtpEndpointResponse.rtpEndpoint.localDescription.sdp, stream);
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })

  // the client's SDP answer for publishing a stream
  socket.on('publishSdpResponse', function(sdp, endpointId, streamUuid) {
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
        ahoymedCallbacks[uuid] = function(response) {
          if (response && response.updateRtpEndpointResponse && response.updateRtpEndpointResponse.success) {
            io.to('conference_' + member.conferenceId).emit('streamStatus', stream, true, member);
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })

  // a client wants to stop streaming media
  socket.on('unpublishStream', function(stream) {
    const conference = conferences[member.conferenceId];
    if (conference) {
      Object.keys(member.streams).forEach(function(streamUuid) {
        if (member.streams[streamUuid].name == stream.name) {
          destroyRtpEndpoint(member.streams[streamUuid].rxRtpEndpointId);
          io.to('conference_' + member.conferenceId).emit('streamStatus', member.streams[streamUuid], false, member);
        }
      });
    }
  });

  // a client wants to subscribe to a stream
  socket.on('subscribeStream', function(stream, audio, video) {
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
          rtcpCheating: config.sdp.rtcpCheating,
          loopback: false,
          pcap: false,
          uuid: uuid
        }
      };
      ahoymedCallbacks[uuid] = function(response) {
        if (response && response.createRtpEndpointResponse && response.createRtpEndpointResponse.rtpEndpoint) {
          var txRtpEndpointId = response.createRtpEndpointResponse.rtpEndpoint.id;
          socket.emit('subscribeSdpRequest', response.createRtpEndpointResponse.rtpEndpoint.localDescription.sdp, txRtpEndpointId, stream);
        }
      };
      ahoymedSocket.send(JSON.stringify(message));
    }
  })

  // the client's SDP answer for receiving a stream
  socket.on('subscribeSdpResponse', function(sdp, endpointId, stream) {
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
        ahoymedCallbacks[uuid] = function(response) {
          if (response && response.updateRtpEndpointResponse && response.updateRtpEndpointResponse.success) {
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })

})

var ahoymedSocket = null;
var ahoymedEventSocket = null;

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

function processAhoymedEventMessage(message) {
  try {
    var json = JSON.parse(message);

    if (json.rtpEndpointTimeOutEvent) {
      var endpointId = json.rtpEndpointTimeOutEvent.id;
      findStreamByEndpointId(endpointId, function(member, stream) {
        if (member && stream) {
          console.log('stream ' + stream.uuid + ' from member ' + member.uuid + ' timed out.');
          io.to('conference_' + member.conferenceId).emit('streamStatus', stream, false, member);
        }
      });
    }
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

  ahoymedEventSocket = zmq.socket('sub');
  ahoymedEventSocket.connect(config.ahoymed.zmqEventUri);
  ahoymedEventSocket.subscribe('APIEVENT');
  ahoymedEventSocket.on('message', function(topic, message) {
    message = message.toString();
    processAhoymedEventMessage(message);
  });

} else {
  ahoymedSocket = new WebSocket(config.ahoymed.wsUri);
  ahoymedSocket.onopen = function() {
    console.log('connected to media engine');
  }
  ahoymedSocket.onmessage = function(msg) {
    processAhoymedMessage(msg.data);
  }
}

