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

async function fetchNearbyRestos(provName, cityName, districtName) {
    try {
        const query = `${districtName}, ${cityName}, ${provName}, Indonesia`;
        const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`, {
            headers: {
                'Accept-Language': 'id',
                'User-Agent': 'BukberChampionshipServer/1.0'
            }
        });

        if (!nomRes.ok) return null;

        const nomData = await nomRes.json();
        if (!nomData || nomData.length === 0) return null;

        const lat = nomData[0].lat;
        const lon = nomData[0].lon;

        const overpassQuery = `
            [out:json][timeout:15];
            (
              node["amenity"~"restaurant|cafe|food_court|fast_food"](around:10000,${lat},${lon});
              way["amenity"~"restaurant|cafe|food_court|fast_food"](around:10000,${lat},${lon});
              relation["amenity"~"restaurant|cafe|food_court|fast_food"](around:10000,${lat},${lon});
            );
            out center 30;
        `;
        const opRes = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'BukberChampionshipServer/1.0'
            },
            body: 'data=' + encodeURIComponent(overpassQuery)
        });
        if (!opRes.ok) {
            console.error("Overpass API error", opRes.status, await opRes.text());
            return null;
        }

        const opText = await opRes.text();
        let opData = null;
        try {
            opData = JSON.parse(opText);
        } catch (e) {
            console.error("Overpass Parsing Error. Raw response:", opText.substring(0, 100));
            return null;
        }
        if (!opData || !opData.elements || opData.elements.length === 0) return null;

        const validElements = opData.elements.filter(e => e.tags && e.tags.name);
        validElements.sort(() => 0.5 - Math.random());

        const restos = validElements.slice(0, 10).map((e) => ({
            id: 'r_osm_' + e.id,
            name: e.tags.name,
            lat: e.lat || e.center?.lat || lat,
            lon: e.lon || e.center?.lon || lon,
            price_range: '10KM Radius',
            menu_highlights: e.tags.cuisine || (e.tags.amenity === 'cafe' ? 'Cafe/Coffee' : 'Kuliner Lokal')
        }));

        return restos.length > 0 ? restos : null;
    } catch (err) {
        console.error("OSM Fetch Error from Backend", err);
        return null;
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_room', async (data) => {
        const { name, groupName, restaurants, locationData } = data;
        const roomId = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit random

        rooms[roomId] = createDefaultRoomState(groupName || 'Bukber Championship');

        let finalRestos = restaurants || [];
        if (locationData) {
            console.log("Fetching location from server:", locationData);
            const fetched = await fetchNearbyRestos(locationData.prov, locationData.city, locationData.district);
            if (fetched) {
                finalRestos = fetched;
                socket.emit('error', `Menemukan ${fetched.length} Restoran!`);
            } else {
                socket.emit('error', 'Gagal memuat peta OSM, menggunakan restoran cadangan.');
            }
        }

        if (finalRestos && Array.isArray(finalRestos) && finalRestos.length > 0) {
            rooms[roomId].restaurants = finalRestos;
        }

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
            // Emit countdown event immediately
            io.to(roomId).emit('show_countdown');

            // Delay actual round 1 start by 4 seconds to allow animation to complete
            setTimeout(() => {
                const currentRoom = rooms[roomId]; // Re-fetch in case room deleted
                if (currentRoom) {
                    currentRoom.round = 'round1';
                    currentRoom.timerEnd = Date.now() + duration;
                    io.to(roomId).emit('state_update', getPublicState(roomId));
                }
            }, 4000);
            return; // Exit early so we don't emit state_update twice
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
