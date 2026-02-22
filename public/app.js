const socket = io();

// State
let currentUser = null;
let currentRoomId = null;
let currentRound = 'entry';
let timerInterval = null;

// DOM Elements
const sections = {
    entry: document.getElementById('section-entry'),
    lobby: document.getElementById('section-lobby'),
    round1: document.getElementById('section-round1'),
    round2: document.getElementById('section-round2'),
    round3: document.getElementById('section-round3'),
    round4: document.getElementById('section-round4'),
    results: document.getElementById('section-results')
};

const inputs = {
    name: document.getElementById('name'),
    groupName: document.getElementById('group-name'),
    roomId: document.getElementById('room-id-input')
};

const display = {
    error: document.getElementById('error-msg'),
    roomId: document.getElementById('display-room-id'),
    usersCount: document.getElementById('users-count'),
    participants: document.getElementById('participants-list')
};

const controls = {
    hostLobby: document.getElementById('host-controls-lobby'),
    hostActive: document.getElementById('host-controls-active'),
    hostResults: document.getElementById('host-controls-results'),
    hostHint: document.getElementById('host-hint')
};

// Location Inputs
const locInputs = {
    prov: document.getElementById('sel-prov'),
    city: document.getElementById('sel-city'),
    district: document.getElementById('sel-district')
};

async function loadProvinces() {
    try {
        const res = await fetch('https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json');
        const data = await res.json();
        if (locInputs.prov) {
            locInputs.prov.innerHTML = '<option value="">Pilih Provinsi</option>' + data.map(p => `<option value="${p.id}" data-name="${p.name}">${p.name}</option>`).join('');
        }
    } catch (e) { console.error('Emsifa prov error', e); }
}

if (locInputs.prov) {
    locInputs.prov.addEventListener('change', async (e) => {
        locInputs.city.innerHTML = '<option value="">Pilih Kota/Kabupaten</option>';
        locInputs.district.innerHTML = '<option value="">Pilih Kecamatan</option>';
        locInputs.city.disabled = true;
        locInputs.district.disabled = true;
        if (!e.target.value) return;

        try {
            const res = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/regencies/${e.target.value}.json`);
            const data = await res.json();
            locInputs.city.innerHTML = '<option value="">Pilih Kota/Kabupaten</option>' + data.map(p => `<option value="${p.id}" data-name="${p.name}">${p.name}</option>`).join('');
            locInputs.city.disabled = false;
        } catch (e) { console.error(e); }
    });

    locInputs.city.addEventListener('change', async (e) => {
        locInputs.district.innerHTML = '<option value="">Pilih Kecamatan</option>';
        locInputs.district.disabled = true;
        if (!e.target.value) return;

        try {
            const res = await fetch(`https://www.emsifa.com/api-wilayah-indonesia/api/districts/${e.target.value}.json`);
            const data = await res.json();
            locInputs.district.innerHTML = '<option value="">Pilih Kecamatan</option>' + data.map(p => `<option value="${p.id}" data-name="${p.name}">${p.name}</option>`).join('');
            locInputs.district.disabled = false;
        } catch (e) { console.error(e); }
    });

    // Initialize provinces
    loadProvinces();
}

async function fetchNearbyRestos(provName, cityName, districtName) {
    // 1. Nominatim
    const query = `${districtName}, ${cityName}, ${provName}, Indonesia`;
    const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
    const nomData = await nomRes.json();
    if (!nomData || nomData.length === 0) return null;

    const lat = nomData[0].lat;
    const lon = nomData[0].lon;

    // 2. Overpass
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery)
    });
    const opData = await opRes.json();

    if (!opData || !opData.elements || opData.elements.length === 0) return null;

    // Filter elements with name
    const validElements = opData.elements.filter(e => e.tags && e.tags.name);
    validElements.sort(() => 0.5 - Math.random()); // Shuffle 

    const restos = validElements.slice(0, 10).map((e, idx) => ({
        id: 'r_osm_' + e.id,
        name: e.tags.name,
        price_range: 'Menyesuaikan',
        menu_highlights: e.tags.cuisine || (e.tags.amenity === 'cafe' ? 'Cafe/Coffee' : 'Kuliner Lokal')
    }));

    return restos.length > 0 ? restos : null;
}

// Handlers
document.getElementById('btn-create-room').addEventListener('click', async () => {
    const name = inputs.name.value.trim();
    const groupName = inputs.groupName.value.trim();
    if (!name) return showError('Name is required');

    const btn = document.getElementById('btn-create-room');
    btn.disabled = true;
    const originalText = btn.innerText;

    let restos = null;
    let locationMessage = "";
    if (locInputs.prov) {
        const provOpt = locInputs.prov.options[locInputs.prov.selectedIndex];
        const cityOpt = locInputs.city.options[locInputs.city.selectedIndex];
        const distOpt = locInputs.district.options[locInputs.district.selectedIndex];

        if (distOpt && distOpt.value) {
            btn.innerText = 'Mencari Tempat (10KM)...';
            try {
                restos = await fetchNearbyRestos(provOpt.dataset.name, cityOpt.dataset.name, distOpt.dataset.name);
                if (!restos) {
                    locationMessage = " (Area tidak terbaca di Maps, pakai resto default)";
                } else {
                    locationMessage = ` (Menemukan ${restos.length} Resto disekitar ${distOpt.dataset.name})`;
                }
            } catch (e) {
                console.error("OSM Fetch failed", e);
                locationMessage = " (Gagal memuat peta)";
            }
        }
    }

    btn.innerText = originalText;
    btn.disabled = false;

    if (locationMessage) {
        showError("Daftar Resto" + locationMessage); // reusing error toast to display info
    }

    socket.emit('create_room', { name, groupName, restaurants: restos });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
    const name = inputs.name.value.trim();
    const roomId = inputs.roomId.value.trim();
    if (!name || !roomId) return showError('Name and Room ID required');
    socket.emit('join_room', { name, roomId });
});

function showError(msg) {
    display.error.textContent = msg;
    display.error.classList.remove('hidden');
    setTimeout(() => display.error.classList.add('hidden'), 3000);
}

function copyRoomId() {
    if (!currentRoomId) return;
    navigator.clipboard.writeText(currentRoomId).then(() => {
        const toast = document.getElementById('copy-toast');
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 2000);
    });
}

// Socket Events
socket.on('error', (msg) => {
    showError(msg);
});

socket.on('login_success', (data) => {
    currentUser = data;
    currentRoomId = data.roomId;
    display.roomId.textContent = currentRoomId;

    // Hide entry, room will render via state_update
});

socket.on('state_update', (state) => {
    console.log('State updated:', state);
    if (!currentUser) return; // Wait until logged in

    // Update Participants in Lobby
    if (state.users) {
        display.usersCount.textContent = state.users.length;
        display.participants.innerHTML = state.users.map(u => `
            <li>
                ${u.isHost ? '<span class="host-crown">👑</span>' : '<span class="host-crown" style="visibility:hidden">👑</span>'}
                <span>${escapeHTML(u.name)} ${u.id === socket.id ? '(You)' : ''}</span>
            </li>
        `).join('');

        // Host controls logic in lobby
        if (currentUser.isHost && state.round === 'lobby') {
            if (state.users.length >= 2) {
                controls.hostLobby.classList.remove('hidden');
                controls.hostHint.classList.add('hidden');
            } else {
                controls.hostLobby.classList.add('hidden');
                controls.hostHint.classList.remove('hidden');
            }
            // Update Admin Resto Modal List
            renderAdminRestoList(state.restaurants);
        }
    }

    // Host controls for active game
    if (currentUser.isHost && state.round !== 'lobby' && state.round !== 'results') {
        controls.hostActive.classList.remove('hidden');
    } else {
        controls.hostActive.classList.add('hidden');
    }

    if (currentUser.isHost && state.round === 'results') {
        controls.hostResults.classList.remove('hidden');
    } else {
        controls.hostResults.classList.add('hidden');
    }


    // Timer Logic
    if (state.timerEnd) {
        startTimer(state.timerEnd, `timer-display-${state.round === 'round1' ? 'r1' : (state.round === 'round2' ? 'r2' : 'r3')}`);
    } else {
        if (timerInterval) clearInterval(timerInterval);
        document.querySelectorAll('.timer-sm').forEach(el => el.classList.add('hidden'));
    }

    // Handle View Switching
    if (currentRound !== state.round || Object.values(sections).every(s => s.classList.contains('hidden'))) {
        currentRound = state.round;
        Object.values(sections).forEach(sec => sec.classList.add('hidden'));

        if (currentRound === 'lobby') {
            sections.lobby.classList.remove('hidden');
        } else if (currentRound === 'round1') {
            sections.round1.classList.remove('hidden');
            renderRound1();
        } else if (currentRound === 'round2') {
            sections.round2.classList.remove('hidden');
            renderRound2(state.topDates);
        } else if (currentRound === 'round3') {
            sections.round3.classList.remove('hidden');
            renderRound3(state.restaurants);
        } else if (currentRound === 'round4') {
            sections.round4.classList.remove('hidden');
            renderRound4(state);
        } else if (currentRound === 'results') {
            sections.results.classList.remove('hidden');
            renderResults(state);
        }
    }

    updateVoteStatus(state);
});

// Voting Logic Variables
let selectedDatesR1 = [];
let selectedDateR2 = null;
let selectedRestosR3 = [];
let selectedRestoR4 = null;

function renderRound1() {
    const container = document.getElementById('round1-options');
    let btnSubmit = document.getElementById('btn-submit-round1');

    // Clone to remove old click listeners safely
    const newBtn = btnSubmit.cloneNode(true);
    btnSubmit.parentNode.replaceChild(newBtn, btnSubmit);
    btnSubmit = newBtn;

    container.innerHTML = '';
    container.classList.remove('waiting-mode');
    btnSubmit.classList.remove('hidden');
    selectedDatesR1 = [];
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Submit Votes';

    const dates = [];
    for (let i = 1; i <= 6; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }

    dates.forEach((date, i) => {
        const box = document.createElement('div');
        box.className = 'option-box animate-slide-up';
        box.style.animationDelay = `${i * 0.05}s`;
        box.innerHTML = `<h3>${formatDate(date)}</h3><p class="subtitle" style="margin:0;font-size:0.8rem;">Tap to select</p>`;
        box.onclick = () => {
            if (box.classList.contains('voted-disabled')) return;
            if (selectedDatesR1.includes(date)) {
                selectedDatesR1 = selectedDatesR1.filter(d => d !== date);
                box.classList.remove('selected');
            } else if (selectedDatesR1.length < 3) {
                selectedDatesR1.push(date);
                box.classList.add('selected');
            }
            btnSubmit.disabled = selectedDatesR1.length === 0;
        };
        container.appendChild(box);
    });

    btnSubmit.addEventListener('click', () => {
        socket.emit('submit_vote', { roomId: currentRoomId, round: 'round1', selection: selectedDatesR1 });
        btnSubmit.disabled = true;
        btnSubmit.innerText = 'Voted!';
    });
}

function renderRound2(topDates) {
    const container = document.getElementById('round2-options');
    let btnSubmit = document.getElementById('btn-submit-round2');

    const newBtn = btnSubmit.cloneNode(true);
    btnSubmit.parentNode.replaceChild(newBtn, btnSubmit);
    btnSubmit = newBtn;

    container.innerHTML = '';
    container.classList.remove('waiting-mode');
    btnSubmit.classList.remove('hidden');
    selectedDateR2 = null;
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Submit Vote';

    topDates.forEach((date, i) => {
        const box = document.createElement('div');
        box.className = 'option-box animate-slide-up';
        box.style.animationDelay = `${i * 0.05}s`;
        box.innerHTML = `<h3>${formatDate(date)}</h3><p class="subtitle" style="margin:0;font-size:0.8rem;">Tap to vote</p>`;
        box.onclick = () => {
            if (box.classList.contains('voted-disabled')) return;
            document.querySelectorAll('#round2-options .option-box').forEach(b => b.classList.remove('selected'));
            box.classList.add('selected');
            selectedDateR2 = date;
            btnSubmit.disabled = false;
        };
        container.appendChild(box);
    });

    btnSubmit.addEventListener('click', () => {
        socket.emit('submit_vote', { roomId: currentRoomId, round: 'round2', selection: selectedDateR2 });
        btnSubmit.disabled = true;
        btnSubmit.innerText = 'Voted!';
    });
}

function renderRound3(restaurants) {
    const container = document.getElementById('round3-options');
    let btnSubmit = document.getElementById('btn-submit-round3');

    const newBtn = btnSubmit.cloneNode(true);
    btnSubmit.parentNode.replaceChild(newBtn, btnSubmit);
    btnSubmit = newBtn;

    container.innerHTML = '';
    container.classList.remove('waiting-mode');
    btnSubmit.classList.remove('hidden');
    selectedRestosR3 = [];
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Submit Votes';

    restaurants.forEach((resto, i) => {
        const box = document.createElement('div');
        box.className = 'option-box resto-card animate-slide-up';
        box.style.animationDelay = `${i * 0.05}s`;
        box.innerHTML = `
            <h4>${escapeHTML(resto.name)}</h4>
            <div class="highlight-badge">${escapeHTML(resto.price_range)}</div>
            <p style="font-size: 0.85rem; color: #ccc; margin:0;">${escapeHTML(resto.menu_highlights)}</p>
        `;
        box.onclick = () => {
            if (box.classList.contains('voted-disabled')) return;
            if (selectedRestosR3.includes(resto.id)) {
                selectedRestosR3 = selectedRestosR3.filter(id => id !== resto.id);
                box.classList.remove('selected');
            } else if (selectedRestosR3.length < 3) {
                selectedRestosR3.push(resto.id);
                box.classList.add('selected');
            }
            btnSubmit.disabled = selectedRestosR3.length === 0;
        };
        container.appendChild(box);
    });

    btnSubmit.addEventListener('click', () => {
        socket.emit('submit_vote', { roomId: currentRoomId, round: 'round3', selection: selectedRestosR3 });
        btnSubmit.disabled = true;
        btnSubmit.innerText = 'Voted!';
    });
}

function renderRound4(state) {
    const container = document.getElementById('round4-options');
    let btnSubmit = document.getElementById('btn-submit-round4');

    const newBtn = btnSubmit.cloneNode(true);
    btnSubmit.parentNode.replaceChild(newBtn, btnSubmit);
    btnSubmit = newBtn;

    container.innerHTML = '';
    container.classList.remove('waiting-mode');
    btnSubmit.classList.remove('hidden');
    selectedRestoR4 = null;
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Submit Vote';

    const topRestos = state.topRestaurants.map(id => state.restaurants.find(r => r.id === id)).filter(Boolean);

    topRestos.forEach((resto, i) => {
        const box = document.createElement('div');
        box.className = 'option-box resto-card animate-slide-up';
        box.style.animationDelay = `${i * 0.05}s`;
        box.innerHTML = `
            <h4>${escapeHTML(resto.name)}</h4>
            <div class="highlight-badge">${escapeHTML(resto.price_range)}</div>
            <p style="font-size: 0.85rem; color: #ccc; margin:0;">${escapeHTML(resto.menu_highlights)}</p>
        `;
        box.onclick = () => {
            if (box.classList.contains('voted-disabled')) return;
            document.querySelectorAll('#round4-options .option-box').forEach(b => b.classList.remove('selected'));
            box.classList.add('selected');
            selectedRestoR4 = resto.id;
            btnSubmit.disabled = false;
        };
        container.appendChild(box);
    });

    btnSubmit.addEventListener('click', () => {
        socket.emit('submit_vote', { roomId: currentRoomId, round: 'round4', selection: selectedRestoR4 });
        btnSubmit.disabled = true;
        btnSubmit.innerText = 'Voted!';
    });
}

function renderResults(state) {
    const container = document.getElementById('results-container');
    container.innerHTML = '';

    const r2Counts = {};
    Object.values(state.votes.round2).forEach(d => r2Counts[d] = (r2Counts[d] || 0) + 1);
    const r2Winner = Object.keys(r2Counts).sort((a, b) => r2Counts[b] - r2Counts[a])[0] || 'TBD';

    const r4Counts = {};
    Object.values(state.votes.round4).forEach(id => r4Counts[id] = (r4Counts[id] || 0) + 1);
    const r4WinnerId = Object.keys(r4Counts).sort((a, b) => r4Counts[b] - r4Counts[a])[0];
    const r4WinnerData = state.restaurants.find(r => r.id === r4WinnerId) || { name: 'TBD' };

    document.getElementById('results-group-name').textContent = state.groupName || 'Bukber Championship';

    container.innerHTML = `
        <p class="subtitle" style="margin-bottom:0.2rem">Kita Bakal Bukber Tanggal</p>
        <h3 style="color:var(--primary-green);font-size: 1.5rem; margin-top:0">${r2Winner !== 'TBD' ? formatDate(r2Winner) : 'TBD'}</h3>
        
        <p class="subtitle" style="margin-top: 1.5rem; margin-bottom:0.2rem">Bukbernya di</p>
        <h3 style="color:var(--primary-green);font-size: 1.5rem; margin-top:0">${escapeHTML(r4WinnerData.name)}</h3>
        
        <div style="margin-top: 2rem;">
            <p class="subtitle text-left" style="text-align:left; margin-bottom: 0.5rem;">Live Final Resto Votes</p>
            <div id="resto-chart"></div>
        </div>
    `;

    const chartContainer = document.getElementById('resto-chart');
    const totalVotesR4 = Math.max(Object.values(state.votes.round4).length, 1);
    const sortedRestos = state.topRestaurants.map(id => state.restaurants.find(r => r.id === id)).filter(Boolean).sort((a, b) => (r4Counts[b.id] || 0) - (r4Counts[a.id] || 0));

    setTimeout(() => {
        sortedRestos.forEach(resto => {
            const count = r4Counts[resto.id] || 0;
            const pct = (count / totalVotesR4) * 100;
            const barHTML = `
                <div class="bar-container">
                    <div class="bar-label">${escapeHTML(resto.name)}</div>
                    <div class="bar-wrapper">
                        <div class="bar-fill" style="width: 0%" data-target-width="${pct}%"></div>
                        <div class="bar-count">${count}</div>
                    </div>
                </div>
            `;
            chartContainer.insertAdjacentHTML('beforeend', barHTML);
        });

        setTimeout(() => {
            document.querySelectorAll('.bar-fill').forEach(fill => {
                fill.style.width = fill.getAttribute('data-target-width');
            });
        }, 100);
    }, 100);
}

function updateVoteStatus(state) {
    if (!currentUser || currentRound === 'lobby' || currentRound === 'results') return;

    // Admin Progress tracking
    if (currentUser.isHost && state.users) {
        const list = document.getElementById('admin-progress-list');
        if (list) {
            list.innerHTML = state.users.map(u => {
                const hasVoted = state.votes[currentRound] && state.votes[currentRound][u.id];
                return `
                    <li>
                        <span>${escapeHTML(u.name)}</span>
                        <span style="margin-left:auto">${hasVoted ? '✅ Voted' : '⏳ Waiting'}</span>
                    </li>
                `;
            }).join('');
        }
    }

    const userVotes = state.votes[currentRound]?.[socket.id];
    if (userVotes) {
        const btnId = `btn-submit-${currentRound}`;
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.add('hidden'); // hide submit button completely

        const gridId = `${currentRound}-options`;
        const grid = document.getElementById(gridId);
        if (grid) {
            const totalUsers = state.users.length;
            const votedUsers = Object.keys(state.votes[currentRound] || {}).length;

            if (!grid.classList.contains('waiting-mode')) {
                grid.innerHTML = `
                    <div class="text-center mt-4" style="padding: 2rem 0;">
                        <div class="spinner"></div>
                        <h3 style="color:var(--primary-green); margin-top:1.5rem;">Votes Submitted!</h3>
                        <p class="status-text" style="margin-bottom: 0.5rem">Waiting for others to finish...</p>
                        <p class="status-text" id="waiting-count-${currentRound}" style="color: var(--text-main); font-weight: bold;">
                            ${votedUsers} / ${totalUsers} voted
                        </p>
                    </div>
                `;
                grid.classList.add('waiting-mode');
            } else {
                const countEl = document.getElementById(`waiting-count-${currentRound}`);
                if (countEl) countEl.textContent = `${votedUsers} / ${totalUsers} voted`;
            }
        }
    }
}

function startTimer(endTime, displayId) {
    if (timerInterval) clearInterval(timerInterval);
    const timerDisplay = document.getElementById(displayId);
    if (!timerDisplay) return;

    document.querySelectorAll('.timer-sm').forEach(el => {
        if (el.id !== displayId) el.classList.add('hidden');
    });
    timerDisplay.classList.remove('hidden');

    const update = () => {
        const now = Date.now();
        const diff = endTime - now;
        if (diff <= 0) {
            timerDisplay.textContent = "00:00";
            clearInterval(timerInterval);
            timerDisplay.classList.add('hidden');
            return;
        }
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        timerDisplay.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    update();
    timerInterval = setInterval(update, 1000);
}

function formatDate(dateStr) {
    try {
        const d = new Date(dateStr);
        if (isNaN(d)) return dateStr;
        return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' });
    } catch {
        return dateStr;
    }
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
}

// Admin Resto Handlers
let localRestos = [];
function renderAdminRestoList(restaurants) {
    localRestos = JSON.parse(JSON.stringify(restaurants)); // Deep copy
    refreshLocalRestoUI();
}

function refreshLocalRestoUI() {
    const list = document.getElementById('admin-resto-list');
    list.innerHTML = localRestos.map(r => `
        <li style="flex-wrap: wrap;">
            <div style="flex: 1; min-width: 150px;">
                <h4 style="margin:0; color:var(--text-main);">${escapeHTML(r.name)}</h4>
                <div style="font-size:0.8rem; color:var(--text-muted);">${escapeHTML(r.price_range)}</div>
            </div>
            <button class="btn-sm btn-outline" style="color: #ff4d4d; border-color: #ff4d4d; padding: 0.3rem 0.6rem;" onclick="deleteRestaurant('${r.id}')">Hapus</button>
        </li>
    `).join('');

    // Auto-save changes to server
    socket.emit('admin_update_restaurants', { roomId: currentRoomId, restaurants: localRestos });
}

function addRestaurant() {
    const name = document.getElementById('new-resto-name').value.trim();
    const price = document.getElementById('new-resto-price').value.trim();
    const menu = document.getElementById('new-resto-menu').value.trim();

    if (!name) return showError("Nama Resto wajid diisi");

    localRestos.push({
        id: 'r_custom_' + Date.now(),
        name,
        price_range: price || '-',
        menu_highlights: menu || '-'
    });

    document.getElementById('new-resto-name').value = '';
    document.getElementById('new-resto-price').value = '';
    document.getElementById('new-resto-menu').value = '';

    refreshLocalRestoUI();
}

function deleteRestaurant(id) {
    if (confirm("Are you sure you want to delete this restaurant?")) {
        localRestos = localRestos.filter(r => r.id !== id);
        refreshLocalRestoUI();
    }
}

function downloadResultAsImage() {
    const resultsSec = document.getElementById('section-results');
    // Hide buttons temporarily before screenshot
    const dlBtn = resultsSec.querySelector('.btn-primary');
    const resetBtn = document.getElementById('host-controls-results');

    if (dlBtn) dlBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';

    // Apply global no-animation class to completely stop html2canvas cloned DOM re-triggering animations
    document.body.classList.add('no-anim');

    html2canvas(resultsSec, {
        backgroundColor: '#F8F4E6', /* Light Theme Background */
        scale: 2 // High res
    }).then(canvas => {
        const link = document.createElement('a');
        link.download = 'Bukber-Result.png';
        link.href = canvas.toDataURL('image/png');
        link.click();

        // Restore buttons and animation
        document.body.classList.remove('no-anim');
        if (dlBtn) dlBtn.style.display = 'inline-block';
        if (resetBtn) resetBtn.style.display = 'flex';
    }).catch(err => {
        console.error("Error generating image", err);
        showError("Failed to generate image.");
        // Restore buttons and animation
        document.body.classList.remove('no-anim');
        if (dlBtn) dlBtn.style.display = 'inline-block';
        if (resetBtn) resetBtn.style.display = 'flex';
    });
}
