const config = require('./config');
const zmq = require('zeromq');
const Uuid = require('node-uuid');
const app = require('express')();
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


io.on('connection', function(socket){
  const member = { uuid: Uuid.v4(), audio: false, video: false, moderator: false };

  socket.on('joinConference', function(conferenceId, password) {
    if (conferences[conferenceId]) {
      const conference = conferences[conferenceId];
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

  socket.on('startMedia', function(audio, video) {
    const conference = conferences[member.conferenceId];
    if (conference) {
      member.audio = audio;
      member.video = video;
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
          loopback: false,
          pcap: false,
          uuid: uuid
         }
        };
        console.log('request: ' + JSON.stringify(message));
        ahoymedCallbacks[uuid] = function(response) {
          console.log('ahoymed response', response);
          if (response && response.createRtpEndpointResponse && response.createRtpEndpointResponse.rtpEndpoint) {
            member.rxRtpEndpointId = response.createRtpEndpointResponse.rtpEndpoint.id;
            socket.emit('sdpRequest', response.createRtpEndpointResponse.rtpEndpoint.localDescription.sdp, member.rxRtpEndpointId, member);
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
      }
    }
  })
  
  socket.on('receiveMedia', function(memberUuid, audio, video) {
    const conference = conferences[member.conferenceId];
    if (conference) {
      var members = conference.members;
      var sourceMember = conference.members[memberUuid];
      if (!sourceMember) return;
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
          socket.emit('sdpRequest', response.createRtpEndpointResponse.rtpEndpoint.localDescription.sdp, txRtpEndpointId, sourceMember);
        }
      };
      ahoymedSocket.send(JSON.stringify(message));
    }
  })
  
  socket.on('sdpResponse', function(sdp, endpointId, sourceEndpointId) {
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
          uuid: uuid
         }
        };
        if (sourceEndpointId) {
          message.updateRtpEndpointRequest.sourceId = sourceEndpointId;
        }
        console.log('request: ' + JSON.stringify(message));
        ahoymedCallbacks[uuid] = function(response) {
          console.log('ahoymed response', response);
          if (response && response.updateRtpEndpointResponse && response.updateRtpEndpointResponse.success) {
            if (!sourceEndpointId) {
              io.to('conference_' + member.conferenceId).emit('memberMediaStatus', member, member.audio, member.video);
            }
          }
        };
        ahoymedSocket.send(JSON.stringify(message));
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

const ahoymedSocket = zmq.socket('dealer');
ahoymedSocket.connect(config.zmq.mediaUri);

ahoymedSocket.on('message', function(message) {
  message = message.toString();
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
})
