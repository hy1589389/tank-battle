const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return c;
}

// Serve index.html
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { host: ws, players: Map<id, {ws, name, color}>, started: bool }
const connInfo = new Map(); // ws -> { roomCode, playerId }

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[连接] ${clientIP}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        let code = genCode();
        while (rooms.has(code)) code = genCode();
        const playerId = 'host_' + code;
        rooms.set(code, {
          host: ws,
          players: new Map([[playerId, { ws, name: msg.name || '主机', color: '#4ecdc4' }]]),
          started: false
        });
        connInfo.set(ws, { roomCode: code, playerId });
        send(ws, { type: 'room_created', roomCode: code, playerId });
        console.log(`[房间] ${code} 已创建`);
        break;
      }

      case 'join_room': {
        const code = msg.roomCode?.toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'error', message: '房间不存在' }); break; }
        if (room.started) { send(ws, { type: 'error', message: '游戏已开始' }); break; }
        if (room.players.size >= 4) { send(ws, { type: 'error', message: '房间已满（最多4人）' }); break; }

        const playerId = 'p_' + Date.now();
        const colors = ['#e94560', '#f5c518', '#9b59b6'];
        const usedColors = [...room.players.values()].map(p => p.color);
        const color = colors.find(c => !usedColors.includes(c)) || '#e94560';

        room.players.set(playerId, { ws, name: msg.name || '玩家' + room.players.size, color });
        connInfo.set(ws, { roomCode: code, playerId });

        // Tell joiner
        const playerList = [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color }));
        send(ws, { type: 'joined_room', playerId, roomCode: code, players: playerList });

        // Tell others
        for (const [id, p] of room.players) {
          if (id !== playerId) send(p.ws, { type: 'player_joined', playerId, name: msg.name || '玩家', color });
        }
        console.log(`[房间] ${code}: ${msg.name} 加入`);
        break;
      }

      case 'start_game': {
        const info = connInfo.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== ws || room.started) break;

        room.started = true;
        const players = [...room.players.entries()].map(([id, p], i) => ({
          id, name: p.name, color: p.color,
          spawnX: [9, 3, 16, 3][i] || 9,
          spawnY: [13, 2, 2, 13][i] || 13
        }));
        for (const [, p] of room.players) {
          send(p.ws, { type: 'game_start', players, mapLevel: 1 });
        }
        console.log(`[房间] ${info.roomCode}: 游戏开始, ${players.length} 人`);
        break;
      }

      case 'game_state': {
        // Host broadcasts state to all join clients
        const info = connInfo.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== ws) break;

        const payload = JSON.stringify({ type: 'game_state', ...msg.data ? msg : msg });
        for (const [id, p] of room.players) {
          if (id !== info.playerId && p.ws.readyState === 1) {
            p.ws.send(payload);
          }
        }
        break;
      }

      case 'input': {
        const info = connInfo.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomCode);
        if (!room || !room.started) break;

        const payload = JSON.stringify({ type: 'input', playerId: info.playerId, dir: msg.dir, shoot: msg.shoot });
        // Forward input to host
        if (room.host.readyState === 1 && room.host !== ws) {
          room.host.send(payload);
        }
        break;
      }

      case 'player_death': {
        const info = connInfo.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomCode);
        if (!room || !room.started) break;
        // Host broadcasts death event
        const payload = JSON.stringify(msg);
        for (const [id, p] of room.players) {
          if (p.ws.readyState === 1) p.ws.send(payload);
        }
        break;
      }

      case 'game_over': {
        const info = connInfo.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomCode);
        if (!room) break;
        for (const [, p] of room.players) {
          send(p.ws, { type: 'game_over', winner: msg.winner, scores: msg.scores });
        }
        break;
      }

      case 'back_to_lobby': {
        const info = connInfo.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== ws) break;
        room.started = false;
        for (const [, p] of room.players) {
          const plist = [...room.players.entries()].map(([id, pp]) => ({ id, name: pp.name, color: pp.color }));
          send(p.ws, { type: 'back_to_lobby', players: plist });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const info = connInfo.get(ws);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) { connInfo.delete(ws); return; }

    if (room.host === ws) {
      // Host left — close room
      for (const [, p] of room.players) { send(p.ws, { type: 'room_closed' }); }
      rooms.delete(info.roomCode);
      console.log(`[房间] ${info.roomCode}: 主机离开，房间关闭`);
    } else {
      room.players.delete(info.playerId);
      for (const [, p] of room.players) { send(p.ws, { type: 'player_left', playerId: info.playerId }); }
    }
    connInfo.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`==================================`);
  console.log(`  坦克大战服务器已启动`);
  console.log(`  本机访问: http://localhost:${PORT}`);
  console.log(`  LAN访问: http://<本机IP>:${PORT}`);
  console.log(`==================================`);
});
