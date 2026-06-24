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

// UKURAN OPTIMAL: 256 KB mengurangi beban pembacaan file dan meningkatkan kecepatan transfer secara drastis
const CHUNK_SIZE = 256 * 1024; 

// Variabel Tambahan untuk Stream ke Disk (Mengatasi Limit RAM)
let fileWritableStream = null;
let writeQueue = [];
let isWriting = false;

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

    // SENDER mendengarkan respon dari RECEIVER
    connection.on('data', (data) => {
        if (data && data.type === 'ready') {
            statusText.innerText = "Penerima siap. Memulai transfer data...";
            sendFileChunks(pendingFile);
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
    statusText.innerText = "Mengirim metadata, menunggu konfirmasi penyimpanan dari penerima...";
    progressSection.classList.remove('hidden');
    fileNameDisplay.innerText = file.name;

    // Kirim Metadata terlebih dahulu
    connection.send({ 
        type: 'metadata', 
        name: file.name, 
        size: file.size, 
        fileType: file.type 
    });
}

function sendFileChunks(file) {
    let offset = 0;
    const reader = new FileReader();
    const dc = connection.dataChannel; 

    if (dc) {
        dc.bufferedAmountLowThreshold = 512 * 1024; // 512 KB
    }

    reader.onload = function(e) {
        if (!connection) return;

        connection.send(e.target.result);
        offset += e.target.result.byteLength;

        const percentage = Math.floor((offset / file.size) * 100);
        progressBar.style.width = percentage + '%';
        progressPercent.innerText = percentage + '%';

        if (offset < file.size) {
            // Rem kecepatan pengiriman jika buffer antrean jaringan penuh (> 2MB)
            if (dc && dc.bufferedAmount > 2 * 1024 * 1024) {
                dc.onbufferedamountlow = () => {
                    dc.onbufferedamountlow = null; 
                    readNext(); 
                };
            } else {
                // Berikan sedikit jeda per 10 chunk agar browser tidak membeku (unresponsive UI)
                if (offset % (CHUNK_SIZE * 10) === 0) {
                    setTimeout(readNext, 1);
                } else {
                    readNext();
                }
            }
        } else {
            statusText.innerText = "Menyelesaikan pengiriman ke disk penerima...";
            const waitDrain = setInterval(() => {
                if (!dc || dc.bufferedAmount === 0) {
                    clearInterval(waitDrain);
                    connection.send({ type: 'done' }); 
                    statusText.innerText = "File Berhasil Dikirim!";
                }
            }, 100);
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
        statusText.innerText = "Terhubung dengan pengirim. Menunggu data file...";
        if (receiverZone) receiverZone.classList.add('hidden');
    });

    connection.on('data', async (data) => {
        // 1. Jika data berupa binary (Chunk File)
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
            
            if (fileWritableStream) {
                // Masukkan ke antrean tulis disk untuk menghindari race condition
                writeQueue.push(data);
                processWriteQueue();
            } else {
                // Fallback ke RAM jika browser tidak mendukung File System Access API
                receivedChunks.push(data);
            }

            receivedSize += data.byteLength !== undefined ? data.byteLength : data.size;

            const percentage = fileMeta ? Math.floor((receivedSize / fileMeta.size) * 100) : 0;
            progressBar.style.width = percentage + '%';
            progressPercent.innerText = percentage + '%';
        } 
        // 2. Jika data berupa Object (Metadata / Sinyal Kontrol)
        else if (data && typeof data === 'object') {
            if (data.type === 'metadata') {
                fileMeta = data;
                fileNameDisplay.innerText = fileMeta.name;
                progressSection.classList.remove('hidden');
                
                receivedChunks = [];
                receivedSize = 0;

                // Fitur Utama: Deteksi kecocokan File System Access API untuk file besar
                if (window.showSaveFilePicker) {
                    statusText.innerHTML = `
                        <div class="text-center">
                            <p class="mb-2 font-semibold text-amber-500">File Besar Terdeteksi (${(fileMeta.size / (1024*1024*1024)).toFixed(2)} GB)</p>
                            <button id="downloadBtn" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded shadow-md transition-all">
                                Pilih Lokasi Simpan & Mulai Terima
                            </button>
                        </div>
                    `;
                    
                    document.getElementById('downloadBtn').addEventListener('click', async () => {
                        try {
                            const handle = await window.showSaveFilePicker({ suggestedName: fileMeta.name });
                            fileWritableStream = await handle.createWritable();
                            statusText.innerText = "Mempersiapkan harddisk, mendownload...";
                            // Kirim sinyal siap ke pengirim setelah file lokal siap ditulis
                            connection.send({ type: 'ready' });
                        } catch (err) {
                            statusText.innerText = "Gagal membuka akses penyimpanan file / Dibatalkan.";
                            console.error(err);
                        }
                    });
                } else {
                    // Fallback normal untuk browser non-Chromium (seperti Firefox/Safari mobile)
                    statusText.innerText = "Menerima file (Disimpan di RAM, berisiko crash pada file > 1.5GB)...";
                    connection.send({ type: 'ready' });
                }
            } 
            
            else if (data.type === 'done') {
                progressBar.style.width = '100%';
                progressPercent.innerText = '100%';

                if (fileWritableStream) {
                    // Tunggu antrean tulis disk benar-benar kosong sebelum menutup file
                    const checkDone = setInterval(async () => {
                        if (writeQueue.length === 0 && !isWriting) {
                            clearInterval(checkDone);
                            await fileWritableStream.close();
                            fileWritableStream = null;
                            statusText.innerText = "Selesai! File berhasil disimpan langsung ke disk lokal Anda.";
                        } else {
                            statusText.innerText = "Sedang menulis sisa data terakhir ke disk...";
                        }
                    }, 100);
                } else {
                    // Eksekusi download fallback konvensional dari RAM
                    statusText.innerText = "Selesai! Mengompilasi file dari RAM...";
                    const blobOptions = fileMeta.fileType ? { type: fileMeta.fileType } : {};
                    const blob = new Blob(receivedChunks, blobOptions);
                    const blobUrl = URL.createObjectURL(blob);
                    
                    const link = document.createElement('a');
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
                }
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

// Fungsi asinkronus untuk menjamin penulisan ke disk berjalan urut (tidak tumpang tindih)
async function processWriteQueue() {
    if (isWriting || writeQueue.length === 0) return;
    isWriting = true;
    
    while (writeQueue.length > 0) {
        const chunk = writeQueue.shift();
        try {
            await fileWritableStream.write(chunk);
        } catch (err) {
            console.error("Gagal menulis chunk ke disk:", err);
        }
    }
    isWriting = false;
}
