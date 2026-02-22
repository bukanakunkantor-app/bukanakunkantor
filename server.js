const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Room State mapping: roomId -> roomState
const rooms = {};

// Default Restaurant Data
const defaultRestaurants = [
    { id: 'r1', name: 'Kampoeng Pasir', price_range: 'Rp 50rb - 100rb', menu_highlights: 'Seafood, Ikan Bakar' },
    { id: 'r2', name: 'Ocean\'s Resto', price_range: 'Rp 100rb - 200rb', menu_highlights: 'Kepiting Soka, Cumi' },
    { id: 'r3', name: 'Dandito', price_range: 'Rp 75rb - 150rb', menu_highlights: 'Kepiting Saus, Udang' },
    { id: 'r4', name: 'Torani', price_range: 'Rp 30rb - 80rb', menu_highlights: 'Bandeng, Aneka Sambal' },
    { id: 'r5', name: 'Blue Sky Bakpao', price_range: 'Rp 20rb - 50rb', menu_highlights: 'Mantau, Sapi Lada Hitam' },
];

function createDefaultRoomState(groupName = '') {
    return {
        round: 'lobby',
        groupName,
        users: {},      // socketId -> { name, isHost }
        votes: { round1: {}, round2: {}, round3: {}, round4: {} },
        timerEnd: null,
        topDates: [],
        topRestaurants: [],
        restaurants: JSON.parse(JSON.stringify(defaultRestaurants))
    };
}

function getPublicState(roomId) {
    const room = rooms[roomId];
    if (!room) return null;
    return {
        roomId,
        round: room.round,
        groupName: room.groupName,
        users: Object.values(room.users),
        timerEnd: room.timerEnd,
        topDates: room.topDates,
        topRestaurants: room.topRestaurants,
        restaurants: room.restaurants,
        votes: room.votes
    };
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_room', (data) => {
        const { name, groupName } = data;
        const roomId = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit random

        rooms[roomId] = createDefaultRoomState(groupName || 'Bukber Championship');
        rooms[roomId].users[socket.id] = { id: socket.id, name, isHost: true };

        socket.join(roomId);
        socket.emit('login_success', { roomId, name, isHost: true });
        io.to(roomId).emit('state_update', getPublicState(roomId));
    });

    socket.on('join_room', (data) => {
        const { name, roomId } = data;
        if (!rooms[roomId]) {
            socket.emit('error', 'Room not found');
            return;
        }

        rooms[roomId].users[socket.id] = { id: socket.id, name, isHost: false };
        socket.join(roomId);
        socket.emit('login_success', { roomId, name, isHost: false });
        io.to(roomId).emit('state_update', getPublicState(roomId));
    });

    socket.on('submit_vote', (data) => {
        const { roomId, round, selection } = data;
        const room = rooms[roomId];
        if (!room || !room.users[socket.id]) return;
        if (room.round !== round) return; // Prevent late votes

        // Single vote enforced per user socket per round
        room.votes[round][socket.id] = selection;

        // Auto-advance logic
        const totalVoters = Object.keys(room.users).length;
        const currentVotes = Object.keys(room.votes[round]).length;

        if (currentVotes >= totalVoters) {
            // Everyone has voted, auto trigger transition
            if (round === 'round1') {
                handleAdminAction(roomId, 'start_round2');
            } else if (round === 'round2') {
                handleAdminAction(roomId, 'start_round3');
            } else if (round === 'round3') {
                handleAdminAction(roomId, 'start_round4');
            } else if (round === 'round4') {
                handleAdminAction(roomId, 'show_results');
            }
        } else {
            io.to(roomId).emit('state_update', getPublicState(roomId)); // Broadcast for live reactions
        }
    });

    socket.on('admin_update_restaurants', (data) => {
        const { roomId, restaurants } = data;
        const room = rooms[roomId];
        if (!room || !room.users[socket.id] || !room.users[socket.id].isHost) return;

        if (room.round === 'lobby') {
            room.restaurants = restaurants;
            io.to(roomId).emit('state_update', getPublicState(roomId));
        }
    });

    function handleAdminAction(roomId, action) {
        const room = rooms[roomId];
        if (!room) return;
        const duration = 10 * 60 * 1000; // 10 minutes

        if (action === 'start_round1') {
            room.round = 'round1';
            room.timerEnd = Date.now() + duration;
        } else if (action === 'start_round2') {
            const counts = {};
            Object.values(room.votes.round1).forEach(dates => {
                if (Array.isArray(dates)) dates.forEach(d => counts[d] = (counts[d] || 0) + 1);
            });
            const sortedDates = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
            room.topDates = sortedDates.slice(0, 2);
            if (room.topDates.length === 0) {
                // fallback if nobody voted
                const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
                room.topDates = [tomorrow.toISOString().split('T')[0]];
            }
            room.round = 'round2';
            room.timerEnd = Date.now() + duration;
        } else if (action === 'start_round3') {
            room.round = 'round3';
            room.timerEnd = Date.now() + duration;
        } else if (action === 'start_round4') {
            const counts = {};
            Object.values(room.votes.round3).forEach(restos => {
                if (Array.isArray(restos)) restos.forEach(r => counts[r] = (counts[r] || 0) + 1);
            });
            const sortedRestos = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
            room.topRestaurants = sortedRestos.slice(0, 2);
            if (room.topRestaurants.length === 0) {
                // fallback
                room.topRestaurants = room.restaurants.slice(0, 2).map(r => r.id);
            }
            room.round = 'round4';
            room.timerEnd = Date.now() + duration;
        } else if (action === 'show_results') {
            room.round = 'results';
            room.timerEnd = null;
        } else if (action === 'reset') {
            room.round = 'lobby';
            room.votes = { round1: {}, round2: {}, round3: {}, round4: {} };
            room.timerEnd = null;
            room.topDates = [];
            room.topRestaurants = [];
        }
        io.to(roomId).emit('state_update', getPublicState(roomId));
    }

    socket.on('admin_action', (data) => {
        const { roomId, action } = data;
        const room = rooms[roomId];
        if (!room || !room.users[socket.id] || !room.users[socket.id].isHost) return;
        handleAdminAction(roomId, action);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        for (const roomId in rooms) {
            if (rooms[roomId].users[socket.id]) {
                const isHost = rooms[roomId].users[socket.id].isHost;
                delete rooms[roomId].users[socket.id];

                // If it was the host and room is empty, we could delete it,
                // but for now let's just broadcast the exit
                if (Object.keys(rooms[roomId].users).length === 0) {
                    delete rooms[roomId]; // Cleanup empty room
                } else {
                    io.to(roomId).emit('state_update', getPublicState(roomId));
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
