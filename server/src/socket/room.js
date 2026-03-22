function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`用户连接: ${user.username || user.id}`);

    // 加入房间频道
    socket.on('join_room', (roomId) => {
      const room = `room-${roomId}`;
      socket.join(room);
      socket.roomId = roomId;
      console.log(`${user.username} 加入房间 ${roomId}`);

      // 通知房间内其他人
      socket.to(room).emit('player_online', { user_id: user.id });
    });

    // 离开房间
    socket.on('leave_room', (roomId) => {
      const room = `room-${roomId}`;
      socket.leave(room);
      socket.to(room).emit('player_offline', { user_id: user.id });
    });

    socket.on('disconnect', () => {
      if (socket.roomId) {
        const room = `room-${socket.roomId}`;
        socket.to(room).emit('player_offline', { user_id: user.id });
      }
    });
  });
}

// 向房间广播游戏事件
function broadcastToRoom(io, roomId, event, data) {
  io.to(`room-${roomId}`).emit(event, data);
}

// 向特定用户发送（通过 user_id 查找 socket）
function sendToUser(io, roomId, userId, event, data) {
  const room = `room-${roomId}`;
  const sockets = io.sockets.adapter.rooms.get(room);
  if (!sockets) return;
  for (const socketId of sockets) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.user && s.user.id === userId) {
      s.emit(event, data);
    }
  }
}

module.exports = { setupSocketHandlers, broadcastToRoom, sendToUser };
