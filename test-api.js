async function test() {
    const provName = 'DKI JAKARTA';
    const cityName = 'KOTA JAKARTA SELATAN';
    const districtName = 'KEBAYORAN BARU';

    const query = `${districtName}, ${cityName}, ${provName}, Indonesia`;
    const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
    const nomData = await nomRes.json();
    console.log("Nom data length:", nomData.length);
    if (!nomData || nomData.length === 0) return null;

    const lat = nomData[0].lat;
    const lon = nomData[0].lon;

    console.log("Lat:", lat, "Lon:", lon);

    const overpassQuery = `
        [out:json][timeout:15];
        (
          node["amenity"~"restaurant|cafe|food_court"](around:10000,${lat},${lon});
        );
        out body 20;
    `;
    const opRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery)
    });
    const opData = await opRes.json();
    console.log("OpData elements:", opData.elements ? opData.elements.length : 'none');
}

test();
