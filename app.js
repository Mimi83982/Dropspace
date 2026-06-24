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
const speedText = document.getElementById('speedText'); // FIX: Hubungkan ke elemen HTML speedText

const peer = new Peer();
let connection = null;
let pendingFile = null; 

// 256 KB adalah ukuran chunk yang jauh lebih optimal untuk WebRTC modern, mengurangi overhead CPU
const CHUNK_SIZE = 256 * 1024; 

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

    connection.send({ 
        type: 'metadata', 
        name: file.name, 
        size: file.size, 
        fileType: file.type 
    });

    setTimeout(() => { sendFileChunks(file); }, 1000);
}

function sendFileChunks(file) {
    let offset = 0;
    const reader = new FileReader();
    const dc = connection.dataChannel; 
    let startTime = Date.now();

    // Batas optimal buffer jaringan agar transfer konstan berkecepatan tinggi
    const BUFFER_HIGH = 16 * 1024 * 1024; // 16 MB (Rem pembacaan jika penuh)
    const BUFFER_LOW = 4 * 1024 * 1024;   // 4 MB (Gas lagi jika di bawah ini)

    if (dc) {
        dc.bufferedAmountLowThreshold = BUFFER_LOW;
    }

    reader.onload = function(e) {
        if (!connection) return;

        connection.send(e.target.result);
        offset += e.target.result.byteLength;

        // Hitung progres & kecepatan (MB/s) aktual
        const percentage = Math.floor((offset / file.size) * 100);
        progressBar.style.width = percentage + '%';
        progressPercent.innerText = percentage + '%';

        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed > 0) {
            const mbps = ((offset / (1024 * 1024)) / elapsed).toFixed(2);
            if (speedText) speedText.innerText = `${mbps} MB/s`;
        }

        if (offset < file.size) {
            // FIX: Cek jika antrean buffer melebihi batas 16MB tinggi
            if (dc && dc.bufferedAmount > BUFFER_HIGH) {
                dc.onbufferedamountlow = () => {
                    dc.onbufferedamountlow = null; 
                    readNext(); // Lanjut setelah buffer terkuras ke bawah 4MB
                };
            } else {
                readNext();
            }
        } else {
            statusText.innerText = "Menyelesaikan pengiriman...";
            const waitDrain = setInterval(() => {
                if (!dc || dc.bufferedAmount === 0) {
                    clearInterval(waitDrain);
                    connection.send({ type: 'done' });
                    statusText.innerText = "File Berhasil Dikirim!";
                    if (speedText) speedText.innerText = "Selesai!";
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
    let receiverStartTime = null;

    connection.on('open', () => {
        statusText.innerText = "Terhubung dengan pengirim!";
        if (receiverZone) receiverZone.classList.add('hidden');
        progressSection.classList.remove('hidden');
    });

    connection.on('data', (data) => {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
            if (!receiverStartTime) receiverStartTime = Date.now();

            receivedChunks.push(data);
            receivedSize += data.byteLength !== undefined ? data.byteLength : data.size;

            const percentage = fileMeta ? Math.floor((receivedSize / fileMeta.size) * 100) : 0;
            progressBar.style.width = percentage + '%';
            progressPercent.innerText = percentage + '%';

            // Menampilkan kecepatan unduh di sisi penerima
            const elapsed = (Date.now() - receiverStartTime) / 1000;
            if (elapsed > 0) {
                const mbps = ((receivedSize / (1024 * 1024)) / elapsed).toFixed(2);
                if (speedText) speedText.innerText = `${mbps} MB/s`;
            }
        } 
        else if (data && typeof data === 'object') {
            if (data.type === 'metadata') {
                fileMeta = data;
                fileNameDisplay.innerText = fileMeta.name;
                receivedChunks = [];
                receivedSize = 0;
                receiverStartTime = null;
            } else if (data.type === 'done') {
                if (fileMeta && receivedSize < fileMeta.size) {
                    console.warn(`Ukuran diterima tidak lengkap.`);
                }

                progressBar.style.width = '100%';
                progressPercent.innerText = '100%';
                statusText.innerText = "Selesai! Mengunduh...";
                if (speedText) speedText.innerText = "Menyimpan...";

                const blobOptions = fileMeta.fileType ? { type: fileMeta.fileType } : {};
                const blob = new Blob(receivedChunks, blobOptions);
                
                const link = document.createElement('a');
                const blobUrl = URL.createObjectURL(blob);
                link.href = blobUrl;
                link.download = fileMeta ? fileMeta.name : 'file_unduhan';
                
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                setTimeout(() => {
                    URL.revokeObjectURL(blobUrl);
                    receivedChunks = []; 
                }, 1000);

                statusText.innerText = "File berhasil disimpan.";
                if (speedText) speedText.innerText = "Selesai!";
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
