const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');

// DOM Elements
const statusText = document.getElementById('statusText');
const dropZone = document.getElementById('dropZone');
const receiverZone = document.getElementById('receiverZone');
const fileInput = document.getElementById('fileInput');
const shareSection = document.getElementById('shareSection');
const shareUrl = document.getElementById('shareUrl');
const copyBtn = document.getElementById('copyBtn');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const fileNameDisplay = document.getElementById('fileName');

const peer = new Peer();
let connection = null;
let pendingFile = null; 
// 64 KB adalah ukuran paling optimal dan aman untuk raw binary WebRTC DataChannel
const CHUNK_SIZE = 64 * 1024; 

// --- INISIALISASI JARINGAN ---
peer.on('open', (id) => {
    if (roomId) {
        statusText.innerText = "Terhubung. Menyambungkan ke pengirim...";
        if (receiverZone) receiverZone.classList.remove('hidden');
        connectToSender(roomId);
    } else {
        statusText.innerText = "Siap membagikan file";
        if (dropZone) dropZone.classList.remove('hidden');
        setupSenderEvents(id);
    }
});

peer.on('error', (err) => {
    statusText.innerText = "Koneksi Error. Silakan refresh halaman.";
    console.error(err);
});

// --- LOGIKA SENDER (PENGIRIM) ---
peer.on('connection', (conn) => {
    connection = conn;
    statusText.innerText = "Penerima terhubung!";

    connection.on('open', () => {
        if (pendingFile) {
            startTransfer(pendingFile);
        } else {
            statusText.innerText = "Penerima terhubung! Menunggu Anda memilih file...";
        }
    });
});

function setupSenderEvents(myId) {
    const fullUrl = `${window.location.origin}${window.location.pathname}?room=${myId}`;
    shareUrl.innerText = fullUrl;
    
    // Pastikan qrcode container ada di HTML
    if (document.getElementById("qrcode")) {
        new QRCode(document.getElementById("qrcode"), { text: fullUrl, width: 144, height: 144 });
    }

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        dropZone.classList.add('border-indigo-500', 'bg-indigo-500/5'); 
    });
    dropZone.addEventListener('dragleave', () => { 
        dropZone.classList.remove('border-indigo-500', 'bg-indigo-500/5'); 
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-indigo-500', 'bg-indigo-500/5');
        if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => { 
        if (e.target.files.length > 0) handleFileSelect(e.target.files[0]); 
    });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(fullUrl);
        copyBtn.innerText = "Tersalin!";
        setTimeout(() => copyBtn.innerText = "Salin Link", 2000);
    });
}

function handleFileSelect(file) {
    shareSection.classList.remove('hidden');
    dropZone.classList.add('hidden');
    pendingFile = file;

    if (connection && connection.open) {
        startTransfer(file);
    } else {
        statusText.innerText = "Menunggu penerima membuka link...";
    }
}

function startTransfer(file) {
    statusText.innerText = "Memulai transfer...";
    progressSection.classList.remove('hidden');
    fileNameDisplay.innerText = file.name;

    // FIX: Kirim Metadata beserta tipe MIME file
    connection.send({ 
        type: 'metadata', 
        name: file.name, 
        size: file.size, 
        fileType: file.type 
    });

    // Kasih jeda 1 detik sebelum kirim file agar koneksi stabil
    setTimeout(() => { sendFileChunks(file); }, 1000);
}

function sendFileChunks(file) {
    let offset = 0;
    const reader = new FileReader();
    const dc = connection.dataChannel; 

    // Set ambang batas buffer untuk trigger onbufferedamountlow
    if (dc) {
        dc.bufferedAmountLowThreshold = 512 * 1024; // 512 KB
    }

    reader.onload = function(e) {
        if (!connection) return;

        // Kirim RAW Data (ArrayBuffer langsung)
        connection.send(e.target.result);
        offset += e.target.result.byteLength;

        const percentage = Math.floor((offset / file.size) * 100);
        progressBar.style.width = percentage + '%';
        progressPercent.innerText = percentage + '%';

        if (offset < file.size) {
            // Rem jika antrean buffer > 1MB
            if (dc && dc.bufferedAmount > 1024 * 1024) {
                dc.onbufferedamountlow = () => {
                    dc.onbufferedamountlow = null; // Bersihkan event listener
                    readNext(); // Lanjut baca file
                };
            } else {
                readNext();
            }
        } else {
            statusText.innerText = "Menyelesaikan pengiriman...";
            // Tunggu semua data di buffer jaringan benar-benar terkuras
            const waitDrain = setInterval(() => {
                if (!dc || dc.bufferedAmount === 0) {
                    clearInterval(waitDrain);
                    connection.send({ type: 'done' }); // Kirim sinyal selesai
                    statusText.innerText = "File Berhasil Dikirim!";
                }
            }, 50);
        }
    };

    function readNext() {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
    }

    readNext();
}

// --- LOGIKA RECEIVER (PENERIMA) ---
function connectToSender(targetId) {
    connection = peer.connect(targetId);

    let receivedChunks = [];
    let fileMeta = null;
    let receivedSize = 0;

    connection.on('open', () => {
        statusText.innerText = "Terhubung dengan pengirim!";
        if (receiverZone) receiverZone.classList.add('hidden');
        progressSection.classList.remove('hidden');
    });

    connection.on('data', (data) => {
        // FIX 1: Support ArrayBuffer, TypedArrays (Uint8Array), and Blobs
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
            receivedChunks.push(data);
            
            // Handle both ArrayBuffer/TypedArray (byteLength) and Blob (size)
            receivedSize += data.byteLength !== undefined ? data.byteLength : data.size;

            const percentage = fileMeta ? Math.floor((receivedSize / fileMeta.size) * 100) : 0;
            progressBar.style.width = percentage + '%';
            progressPercent.innerText = percentage + '%';
        } 
        // Jika data yang diterima adalah Object (Metadata / Sinyal Kontrol)
        else if (data && typeof data === 'object') {
            if (data.type === 'metadata') {
                fileMeta = data;
                fileNameDisplay.innerText = fileMeta.name;
                receivedChunks = [];
                receivedSize = 0;
            } else if (data.type === 'done') {
                if (fileMeta && receivedSize < fileMeta.size) {
                    console.warn(`Ukuran diterima (${receivedSize}) lebih kecil dari ukuran asli (${fileMeta.size}). File mungkin tidak lengkap.`);
                }

                progressBar.style.width = '100%';
                progressPercent.innerText = '100%';
                statusText.innerText = "Selesai! Mengunduh...";

                // FIX 2: Attach the correct MIME type to the Blob
                const blobOptions = fileMeta.fileType ? { type: fileMeta.fileType } : {};
                const blob = new Blob(receivedChunks, blobOptions);
                
                // FIX 3: Mobile Chrome Download Workaround
                const link = document.createElement('a');
                const blobUrl = URL.createObjectURL(blob);
                link.href = blobUrl;
                link.download = fileMeta ? fileMeta.name : 'file_unduhan';
                
                // Harus ditempel ke DOM dulu agar mobile Chrome mengeksekusi kliknya
                document.body.appendChild(link);
                link.click();
                
                // Bersihkan DOM
                document.body.removeChild(link);

                // FIX 4: Kosongkan RAM agar browser tidak crash pada file berukuran besar
                setTimeout(() => {
                    URL.revokeObjectURL(blobUrl);
                    receivedChunks = []; 
                }, 1000);

                statusText.innerText = "File berhasil disimpan.";
            }
        }
    });

    connection.on('close', () => {
        if (!fileMeta || receivedSize < (fileMeta ? fileMeta.size : 0)) {
            statusText.innerText = "Koneksi terputus sebelum transfer selesai.";
        }
    });

    connection.on('error', (err) => {
        console.error(err);
        statusText.innerText = "Terjadi error saat transfer.";
    });
}
