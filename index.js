require("dotenv").config()
process.on("uncaughtException", (err) => {
    if (err.message?.includes("fetch failed") || err.message?.includes("timeout")) return
    console.error("🔥 Uncaught Exception:", err)
})
process.on("unhandledRejection", (reason) => {
    if (reason?.message?.includes("fetch failed") || reason?.message?.includes("timeout")) return
    console.error("🔥 Unhandled Rejection:", reason)
})

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys")

const P = require("pino")
const axios = require("axios")
const fs = require("fs-extra")
const path = require("path")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("ffmpeg-static")
const sharp = require("sharp")
const { createCanvas } = require("canvas")

// 🔥 Penanganan FFmpeg (Gunakan sistem jika ada, jika tidak gunakan static)
const { execSync } = require("child_process")
let ffmpegCmd = "ffmpeg"
try {
    execSync("ffmpeg -version", { stdio: "ignore" })
} catch {
    ffmpegCmd = ffmpegPath
}
ffmpeg.setFfmpegPath(ffmpegCmd)

const PHONE_NUMBER = process.env.PHONE_NUMBER || "6287886582175"
const API_KEY = process.env.GROQ_API_KEY || "GANTI_API_KEY"

if (!PHONE_NUMBER || PHONE_NUMBER === "628xxx") {
    console.log("❌ PHONE_NUMBER di .env belum diatur dengan benar!")
    process.exit(1)
}
if (!API_KEY || API_KEY === "GANTI_API_KEY") {
    console.log("⚠️ GROQ_API_KEY belum diatur. Fitur AI tidak akan berfungsi.")
}

/* ================= DATABASE ================= */
const DATA_DIR = path.join(__dirname, "data")
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const DB_PATH = path.join(DATA_DIR, "database.json")
let db = {
    greetings: [],
    antilink: [],
    undangan: {},
    banned: {},
    ai: {},
    contacts: {}
}

function loadDb() {
    try {
        if (fs.existsSync(DB_PATH)) {
            db = fs.readJsonSync(DB_PATH)
            // Migration & Safety
            if (!db.contacts) db.contacts = {}
            if (!db.greetings) db.greetings = []
            if (!db.antilink) db.antilink = []
            if (!db.undangan) db.undangan = {}
            if (!db.banned) db.banned = {}
            if (!db.ai) db.ai = {}
        } else {
            fs.writeJsonSync(DB_PATH, db, { spaces: 2 })
        }
    } catch (e) {
        console.error("⚠️ DB Error on Load:", e)
    }
}

async function saveDb() {
    try {
        await fs.writeJson(DB_PATH, db, { spaces: 2 })
    } catch (e) {
        console.error("⚠️ DB Error on Save:", e)
    }
}

loadDb()

// Helper maps for easy access
const greetGroups = new Set(db.greetings)
const antilinkGroups = new Set(db.antilink)
const undanganGroups = db.undangan
const bannedMembers = db.banned
const aiMemory = db.ai
const contacts = db.contacts

const groupCache = {} // 🔥 Cache Admin Fast Respon
const memory = {}
const aiMode = {}
const spam = {}
const cooldowns = new Map() // 🔥 Silent Anti-Spam
const detectionSession = {} // 🔥 Ghost Member Detection State

let isSaving = false
async function throttledSaveDb() {
    if (isSaving) return
    isSaving = true
    setTimeout(async () => {
        await saveDb()
        isSaving = false
    }, 2000) // Simpan maksimal tiap 2 detik
}

function syncDb() {
    db.greetings = Array.from(greetGroups)
    db.antilink = Array.from(antilinkGroups)
    throttledSaveDb()
}

let pairingPrinted = false
let pairingCodeRequested = false

/* ================= HELPERS ================= */

async function getBuffer(message, type) {
    const stream = await downloadContentFromMessage(message, type)
    let buffer = Buffer.from([])
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk])
    }
    return buffer
}

async function bufferFromStream(stream) {
    let buffer = Buffer.from([])
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk])
    }
    return buffer
}

async function toWebp(buffer) {
    try {
        return await sharp(buffer)
            .resize(512, 512, { fit: "cover" })
            .webp()
            .toBuffer()
    } catch {
        return null
    }
}

async function askAI(messages) {
    try {
        const res = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            { model: "llama-3.3-70b-versatile", messages },
            {
                headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
                timeout: 10000 // 10 detik timeout
            }
        )
        return res.data.choices[0].message.content
    } catch {
        return "⚠️ AI sedang sibuk atau koneksi lambat"
    }
}

async function textToVoice(text) {
    try {
        const res = await axios.get(
            `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`,
            { responseType: "arraybuffer" }
        )
        return Buffer.from(res.data)
    } catch {
        return null
    }
}

async function textToSticker(text) {
    try {
        const res = await axios.get(
            `https://api.memegen.link/images/custom/-/${encodeURIComponent(text)}.png`,
            { responseType: "arraybuffer" }
        )
        const png = Buffer.from(res.data)
        return await toWebp(png)
    } catch {
        return null
    }
}

async function videoToAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec("libmp3lame")
            .save(outputPath)
            .on("end", resolve)
            .on("error", reject)
    })
}

/* ================= START BOT ================= */

let isConnecting = false
async function startBot() {
    if (isConnecting) return
    isConnecting = true

    const { state, saveCreds } = await useMultiFileAuthState("./data/session")
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        printQRInTerminal: false
    })

    sock.ev.on("creds.update", saveCreds)
    console.log("🚀 Bot WhatsApp Aktif")

    /* ================= CONNECTION ================= */
    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update
        if (connection === "connecting") console.log("🔄 Menghubungkan ke WhatsApp...")
        if (connection === "open") {
            console.log("✅ Bot terhubung")
            isConnecting = false
        }
        if (connection === "close") {
            isConnecting = false
            const reason = lastDisconnect?.error?.output?.statusCode
            console.log("❌ Koneksi terputus, alasan:", reason)

            const shouldReconnect = reason !== DisconnectReason.loggedOut
            if (shouldReconnect) {
                pairingPrinted = false
                pairingCodeRequested = false
                console.log("🔄 Koneksi terputus. Mencoba menghubungkan ulang dalam 5 detik...")
                setTimeout(startBot, 5000)
            } else {
                console.log("🛑 Sesi Berakhir (Logged Out).")
                console.log("Jika ini terjadi di server, silakan hapus folder 'session' dan jalankan ulang di lokal untuk mendapatkan pairing code baru.")
                // fs.removeSync("./session") // Opsional: hapus sesi jika benar-benar ingin reset
                process.exit(0)
            }
        }

        if (qr && !sock.authState.creds.registered && !pairingPrinted) {
            pairingPrinted = true
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER)
                    console.log("================================")
                    console.log("PAIRING CODE WHATSAPP")
                    console.log(code)
                    console.log("================================")
                } catch (err) {
                    console.log("❌ Gagal pairing:", err)
                    pairingPrinted = false
                }
            }, 3000)
        }
    })

    /* ================= WELCOME MEMBER & KICK BANNED ================= */
    sock.ev.on("group-participants.update", async (data) => {
        try {
            const groupId = data.id
            const addedUsers = data.participants || []

            // kick banned member otomatis
            if (data.action === "add") {
                for (const participant of addedUsers) {
                    const userId = typeof participant === "string" ? participant : participant.id
                    if (bannedMembers[groupId]?.includes(userId)) {
                        await sock.groupParticipantsUpdate(groupId, [userId], "remove").catch(() => { })
                    }
                }
            }

            // 🔥 INVALIDASI CACHE ADMIN JIKA ADA PERUBAHAN ADMIN
            if (data.action === "promote" || data.action === "demote" || data.action === "remove") {
                delete groupCache[groupId]
            }

            // 🔥 OTOMATIS BLACKLIST KETIKA OUT / KICK
            if (data.action === "remove") {
                let changed = false
                for (const participant of addedUsers) {
                    const userId = typeof participant === "string" ? participant : participant.id
                    if (!bannedMembers[groupId]) bannedMembers[groupId] = []
                    if (!bannedMembers[groupId].includes(userId)) {
                        bannedMembers[groupId].push(userId)
                        changed = true
                    }

                    // Kirim pesan Goodbye jika aktif
                    if (greetGroups.has(groupId)) {
                        const user = userId.split("@")[0]
                        const text = `
👋 Selamat tinggal @${user}
˚ ༘♡ ·˚꒰ Ꮆㄖㄖᗪ乃ㄚ乇 ꒱ ₊˚ˑ༄

Sayonara! Semoga harimu menyenangkan di luar sana.
*NIGHTFALL SILENT SLAUGHTER*
                        `
                        await sock.sendMessage(groupId, { text, mentions: [userId] }).catch(() => { })
                    }
                }
                if (changed) await saveDb()
            }

            // kirim welcome
            if (data.action === "add" && greetGroups.has(groupId)) {
                for (const participant of addedUsers) {
                    const userId = typeof participant === "string" ? participant : participant.id
                    const user = userId.split("@")[0]
                    const text = `
👋 Selamat datang @${user}
˚ ༘♡ ·˚꒰ ᨰׁׅꫀׁׅܻ݊ᥣׁׅ֪ᝯׁ֒ᨵׁׅׅꩇׁׅ֪݊ ꫀׁׅܻ݊ ꒱ ₊˚ˑ༄

*NIGHTFALL SILENT SLAUGHTER*

Nama:
Usn:
Umur:
Asal:
Sudah bisa CN / Belum?
                    `
                    await sock.sendMessage(groupId, { text, mentions: [userId] }).catch(() => { })
                }
            }
        } catch (e) {
            console.error("⚠️ Participant Update Error (Ignored):", e.message)
        }
    })

    /* ================= MESSAGE ================= */
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0]
            if (!msg.message) return
            const from = msg.key.remoteJid
            const sender = msg.key.participant || from
            const pushName = msg.pushName || "No Name"

            // 🔥 RECORD CONTACT NAME
            if (pushName !== "No Name" && !contacts[sender]) {
                contacts[sender] = pushName
                await saveDb()
            }

            // 🔥 TRACK DETECTION ACTIVITY
            if (from.endsWith("@g.us") && detectionSession[from]) {
                detectionSession[from].chatters.add(sender)
            }

            // 🔥 UNWRAP EPHEMERAL & VIEW ONCE
            let body = msg.message
            if (body.ephemeralMessage) body = body.ephemeralMessage.message
            if (body.viewOnceMessage) body = body.viewOnceMessage.message
            if (body.viewOnceMessageV2) body = body.viewOnceMessageV2.message

            const type = Object.keys(body)[0]
            const text = body.conversation ||
                body.extendedTextMessage?.text ||
                body.imageMessage?.caption ||
                body.videoMessage?.caption ||
                ""

            const isCmd = text.startsWith(".")

            // Helper Reaksi
            const react = async (emoji) => {
                await sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
            }

            /* ================= SILENT ANTI-SPAM (100% AKURAT) ================= */
            const now = Date.now()
            if (cooldowns.has(sender)) {
                if (now < cooldowns.get(sender)) return // 🤫 Abaikan diam-diam selama hukuman
                else cooldowns.delete(sender)
            }

            if (!spam[sender]) spam[sender] = []
            spam[sender] = spam[sender].filter(time => now - time < 4000)
            spam[sender].push(now)

            if (spam[sender].length > 6) {
                cooldowns.set(sender, now + 10000) // Hukuman 10 detik
                return sock.sendMessage(from, { text: "⚠️ *ANTI-SPAM AKTIF*\n\nAnda terlalu cepat! Mohon tunggu 10 detik agar Bot bisa bernapas." })
            }

            /* ================= CEK ADMIN (OPTIMIZED CACHE) ================= */
            let isAdmin = false
            if (from.endsWith("@g.us")) {
                if (!groupCache[from]) {
                    const metadata = await sock.groupMetadata(from)
                    groupCache[from] = metadata.participants.filter(p => p.admin).map(p => p.id)
                }
                isAdmin = groupCache[from].includes(sender)
            }

            /* ================= AUTO REACT CMD (DISABLED FOR INVALID) ================= */
            // Reaksi dipindahkan ke dalam masing-masing handler command agar akurat

            /* ================= MENU ================= */
            if (text === ".menu") {
                react("🕒")
                react("📋")
                return sock.sendMessage(from, {
                    image: { url: "https://i.ibb.co.com/sJgL5vwR/static.png" },
                    caption: `
☆「 NSSxFii MENU 」

╔┈「 ADMIN MENU 」
╎- 》.setgreet
╎- 》.setundangan
╎- 》.stopundangan
╎- 》.listout
╎- 》.delout @tag
╎- 》.antilink
╎- 》.kick
╎- 》.open
╎- 》.close
╎- 》.deteksi
╎- 》.ghosts
╎┈「 MEMBER MENU 」
╎- 》.rules
╚┈┈┈┈┈┈┈┈┈┈┈┈
╔┈「 AI-FII MENU 」
╎- 》.chat → Aktifkan AI
╎- 》.off → Matikan AI
╎- 》.reset → Reset Memory
╚┈┈┈┈┈┈┈┈┈┈┈┈
╔┈「 MENU-FII 」
╎- 》.brat teks
╎- 》.stiker (gambar + caption)
╎- 》.tts teks
╎- 》.mp3 convert mp4 → mp3
╎- 》.tiktok link
╚┈┈┈┈┈┈┈┈┈┈┈┈
                    `
                })
            }

            /* ================= ADMIN COMMAND ================= */
            /* ================= CLOSE GROUP ================= */
            if (text === ".close") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang dapat mengakses fitur ini 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜" })
                react("🕒")
                react("🔒")
                await sock.groupSettingUpdate(from, "announcement")
                react("✅")
                return sock.sendMessage(from, { text: "🔒 Grup telah ditutup (hanya admin yang bisa kirim pesan)" })
            }

            /* ================= OPEN GROUP ================= */
            if (text === ".open") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang dapat mengakses fitur ini 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜" })
                react("🕒")
                react("🔓")
                await sock.groupSettingUpdate(from, "not_announcement")
                react("✅")
                return sock.sendMessage(from, { text: "🔓 Grup telah dibuka (semua member bisa kirim pesan)" })
            }

            if (text === ".setgreet") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                await react("📢")
                if (greetGroups.has(from)) {
                    greetGroups.delete(from)
                    syncDb()
                    await react("🛑")
                    return sock.sendMessage(from, { text: "🛑 Fitur Greetings (Welcome & Goodbye) dinonaktifkan" })
                } else {
                    greetGroups.add(from)
                    syncDb()
                    await react("✅")
                    return sock.sendMessage(from, { text: "✅ Fitur Greetings (Welcome & Goodbye) diaktifkan 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜" })
                }
            }

            if (text === ".listout") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                await react("📂")
                const list = bannedMembers[from] || []
                if (list.length === 0) return sock.sendMessage(from, { text: "📂 Belum ada member yang keluar/di-blacklist" })
                let teks = "📂 *[ LIST MEMBER OUT / BLACKLIST ]*\n\n"
                list.forEach((id, i) => {
                    const name = contacts[id]
                    const num = id.split("@")[0]
                    if (name) {
                        teks += `${i + 1}. ${name} (${num})\n`
                    } else {
                        teks += `${i + 1}. ${num}\n`
                    }
                })
                teks += "\n_Gunakan .delout nomor untuk menghapus._\nContoh: `.delout 628xxx`"
                await react("✅")
                return sock.sendMessage(from, { text: teks })
            }

            if (text.startsWith(".delout")) {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })

                let targetNum = []
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
                if (mentioned && mentioned.length > 0) {
                    targetNum = mentioned.map(id => id.split("@")[0])
                } else {
                    const args = text.split(" ")[1]
                    if (args) {
                        let num = args.replace(/[^0-9]/g, "")
                        // 🔥 NORMALISASI: ubah 08xxx jadi 628xxx
                        if (num.startsWith("0")) num = "62" + num.slice(1)
                        if (num.length > 10) targetNum.push(num)
                    }
                }

                if (targetNum.length === 0) return sock.sendMessage(from, { text: "⚠️ Tag member atau ketik nomornya untuk dihapus dari blacklist\nContoh:\n.delout @tag\n.delout 08xxx" })

                if (!bannedMembers[from]) bannedMembers[from] = []

                // 🔥 HAPUS DENGAN PENCOCOKAN NOMOR AGAR 100% AKURAT
                const initialLength = bannedMembers[from].length
                bannedMembers[from] = bannedMembers[from].filter(id => {
                    const num = id.split("@")[0]
                    return !targetNum.includes(num)
                })

                if (bannedMembers[from].length === initialLength) {
                    await react("❌")
                    return sock.sendMessage(from, { text: "⚠️ Member tidak ditemukan dalam daftar blacklist grup ini.\n_(Pastikan nomor yang Anda ketik benar)_" })
                }

                await saveDb()
                await react("✅")
                return sock.sendMessage(from, { text: "✅ Member berhasil diizinkan join kembali." })
            }

            if (text === ".rules") {
                react("🕒")
                react("📜")
                return sock.sendMessage(from, {
                    text: `📜 *[ RULES NIGHTFALL SILENT SLAUGHTER ]*
*1. WAJIB 17+*
*2. DILARANG DRAMA SESAMA MEMBER*
*3. DILARANG MEMBUAT KERIBUTAN DALAM STATUS MENYANDANG NAMA CLAN, MAKA AKAN DIKENAKAN SANKSI*
*4. DILARANG MENJELEKKAN SESAMA MEMBER DAN ORG LAIN*
*5. DILARANG KERAS OUT YG DISEBABKAN PACARAN*
*6. HARUS KOMPAK DAN SALING BERBAUR JANGAN DICUEKIN SESAMA MEMBER*
*7. ⁠DILARANG NGETAG GRUP KE STATUS KECUALI TENTANG GAME COLAB ATAUPUN JUALAN*
*8. ⁠WAJIB BISA CN (GANTI NAMA)*
*9. JAGA NAMA BAIK CLAN*
*10. DILARANG KERASS BERMUKA DUAA!!*
*11. ⁠MASUK BAIK BAIK, OUT JUGA HARUS BAIK BAIK DENGAN BILANG DULU KE STAF*
*12. ⁠DILARANG KERAS UNTUK MENANYAKAN YANG MENYANGKUT HAL PRIBADI KE MEMBER LAINNYA*
*13. JAGA SOPAN SANTUN SESAMA MEMBER ATAU PUN STAFF*
*14. YANG SUDAH OUT TIDA BISA JOIN LAGI DENGAN ALASAN APAPUN ITU*
LINK DISCORD : https://discord.gg/JuAq2NBf6
LINK VARCITY : https://www.roblox.com/share?code=4e879bb8c0113d429e2b3381537c0e5f&type=AvatarItemDetails`
                })
            }

            if (text === ".antilink") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                await react("🛡️")
                if (antilinkGroups.has(from)) {
                    antilinkGroups.delete(from)
                    syncDb()
                    await react("🛑")
                    return sock.sendMessage(from, { text: "✅ Anti link dinonaktifkan" })
                } else {
                    antilinkGroups.add(from)
                    syncDb()
                    await react("✅")
                    return sock.sendMessage(from, { text: "🚫 Anti link diaktifkan 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜" })
                }
            }

            if (antilinkGroups.has(from) && (text.includes("chat.whatsapp.com") || text.includes("wa.me/settings"))) {
                if (isAdmin) return // 🔥 Abaikan jika pengirim adalah admin

                // 🔥 Hapus pesan link
                await sock.sendMessage(from, { delete: msg.key })

                // 🔥 Berikan peringatan
                return sock.sendMessage(from, {
                    text: `⚠️ *ANTI LINK DETECTED*\n\nMaaf @${sender.split("@")[0]}, link tidak diizinkan di sini! Pesan Anda telah dihapus otomatis.`,
                    mentions: [sender]
                })
            }

            if (text.startsWith(".kick")) {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                await react("👞")
                if (!msg.message.extendedTextMessage) return
                const mentioned = msg.message.extendedTextMessage.contextInfo?.mentionedJid
                if (!mentioned) return
                // tandai sebagai banned
                if (!bannedMembers[from]) bannedMembers[from] = []
                bannedMembers[from].push(...mentioned)
                saveDb()
                await sock.groupParticipantsUpdate(from, mentioned, "remove")
                await react("✅")
            }

            if (text.startsWith(".setundangan")) {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                const pesan = text.replace(".setundangan", "").trim()
                if (!pesan) return sock.sendMessage(from, { text: "Contoh:\n.setundangan Ayo join clan NIGHTFALL" })
                undanganGroups[from] = { text: pesan, timer: null }
                saveDb()
                return sock.sendMessage(from, { text: "✅ Pesan undangan disimpan\nGunakan .interval untuk memulai 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜" })
            }

            if (text.startsWith(".interval")) {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                if (!undanganGroups[from]) return sock.sendMessage(from, { text: "⚠️ Gunakan .setundangan dulu" })
                const waktu = text.split(" ")[1]
                let ms = { "1menit": 60000, "2menit": 120000, "3menit": 180000, "4menit": 240000, "5menit": 300000, "6menit": 360000, "7menit": 420000, "8menit": 480000, "9menit": 540000, "10menit": 600000, "30menit": 1800000, "1jam": 3600000, "2jam": 7200000 }[waktu]
                if (!ms) return sock.sendMessage(from, { text: "Gunakan:\n.interval 30menit\n.interval 1jam\n.interval 2jam" })
                if (undanganGroups[from].timer) clearInterval(undanganGroups[from].timer)
                undanganGroups[from].timer = setInterval(async () => {
                    await sock.sendMessage(from, { text: undanganGroups[from].text })
                }, ms)
                return sock.sendMessage(from, { text: `✅ Undangan otomatis aktif setiap ${waktu}` })
            }

            if (text === ".stopundangan") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                if (!undanganGroups[from]) return sock.sendMessage(from, { text: "⚠️ Undangan belum aktif" })
                if (undanganGroups[from].timer) clearInterval(undanganGroups[from].timer)
                delete undanganGroups[from]
                saveDb()
                return sock.sendMessage(from, { text: "🛑 Undangan otomatis dihentikan 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜" })
            }

            /* ================= DETECTION ================= */
            if (text === ".deteksi") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                if (detectionSession[from]) return sock.sendMessage(from, { text: "⚠️ Deteksi sudah berjalan di grup ini. Gunakan `.ghosts` untuk melihat hasil." })

                try {
                    await react("🕒")
                    // Mengambil metadata grup dengan timeout agar tidak macet
                    const metadata = await sock.groupMetadata(from).catch(() => null)
                    if (!metadata) {
                        await react("❌")
                        return sock.sendMessage(from, { text: "❌ Gagal mengambil data grup. Pastikan bot masih menjadi admin." })
                    }

                    const participants = metadata.participants.map(p => p.id)

                    detectionSession[from] = {
                        participants: participants,
                        chatters: new Set(),
                        startTime: Date.now()
                    }

                    await react("✅")
                    return sock.sendMessage(from, { text: "🔍 *DETEKSI DIMULAI*\n\nBot mulai memantau aktivitas chat secara real-time.\nTotal Member: " + participants.length + "\n\nKetik `.ghosts` untuk melihat daftar member yang belum chat." })
                } catch (err) {
                    console.error("Deteksi Error:", err)
                    await react("❌")
                    return sock.sendMessage(from, { text: "❌ Terjadi kesalahan internal saat memulai deteksi." })
                }
            }

            if (text === ".ghosts") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                if (!detectionSession[from]) return sock.sendMessage(from, { text: "⚠️ Deteksi belum diaktifkan. Ketik `.deteksi` untuk memulai." })

                try {
                    await react("🕒")
                    const session = detectionSession[from]
                    // Filter member yang tidak ada di chatters
                    const ghosts = session.participants.filter(p => !session.chatters.has(p))

                    if (ghosts.length === 0) {
                        delete detectionSession[from]
                        await react("✅")
                        return sock.sendMessage(from, { text: "✅ *DETEKSI SELESAI*\n\nLuar biasa! Semua member (" + session.participants.length + ") aktif mengirim pesan!" })
                    }

                    let teks = `🔍 *[ HASIL DETEKSI GHOST ]*\n\n`
                    teks += `Total Member: ${session.participants.length}\n`
                    teks += `Member Aktif: ${session.chatters.size}\n`
                    teks += `Member Ghost: ${ghosts.length}\n\n`
                    teks += `*DAFTAR MEMBER GHOST:*\n`

                    // Batasi daftar agar pesan tidak terlalu panjang (limit WA 4096 char)
                    const displayLimit = 150
                    const displayGhosts = ghosts.slice(0, displayLimit)

                    displayGhosts.forEach((id, i) => {
                        teks += `${i + 1}. @${id.split("@")[0]}\n`
                    })

                    if (ghosts.length > displayLimit) {
                        teks += `\n_...dan ${ghosts.length - displayLimit} member lainnya (terlalu banyak untuk ditampilkan)._\n`
                    }

                    teks += `\n_Ketik .deteksi off untuk mengakhiri Sesi Deteksi ini._`

                    await react("✅")
                    return sock.sendMessage(from, { text: teks, mentions: ghosts })
                } catch (err) {
                    console.error("Ghosts Error:", err)
                    await react("❌")
                    return sock.sendMessage(from, { text: "❌ Terjadi kesalahan saat memproses data ghost." })
                }
            }

            if (text === ".deteksi off") {
                if (!isAdmin) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa pakai command ini" })
                if (!detectionSession[from]) return sock.sendMessage(from, { text: "⚠️ Deteksi tidak sedang berjalan." })
                delete detectionSession[from]
                await react("🛑")
                return sock.sendMessage(from, { text: "🛑 Sesi deteksi dihentikan. Data aktivitas telah dihapus." })
            }

            /* ================= AI ================= */
            if (!aiMemory[sender]) aiMemory[sender] = [{ role: "system", content: "Kamu adalah AI WhatsApp santai dan membantu." }]
            if (text === ".chat") { aiMode[sender] = true; return sock.sendMessage(from, { text: "🤖 AI aktif" }) }
            if (text === ".off") { aiMode[sender] = false; aiMemory[sender] = []; saveDb(); return sock.sendMessage(from, { text: "❌ AI mati" }) }
            if (text === ".reset") { aiMemory[sender] = []; saveDb(); return sock.sendMessage(from, { text: "🧠 Memory direset" }) }
            if (aiMode[sender] && text && !isCmd) {
                await react("🤖")
                aiMemory[sender].push({ role: "user", content: text })
                if (aiMemory[sender].length > 20) aiMemory[sender].splice(1, 1)
                const reply = await askAI(aiMemory[sender])
                aiMemory[sender].push({ role: "assistant", content: reply })
                saveDb()
                await react("💬")
                return sock.sendMessage(from, { text: reply })
            }

            // 🔥 STICKER (UPGRADED VERSION)
            if (msg.message?.imageMessage && text === ".stiker") {
                react("🕒")
                react("🎨")
                try {
                    const buffer = await getBuffer(msg.message.imageMessage, 'image')
                    const webp = await sharp(buffer)
                        .resize(512, 512, { fit: "cover", position: "centre" })
                        .webp().toBuffer()
                    await react("✅")
                    return sock.sendMessage(from, { sticker: webp })
                } catch (err) {
                    console.error("Sticker Error:", err)
                    await react("❌")
                    return sock.sendMessage(from, { text: "❌ Gagal membuat stiker" })
                }
            }

            /* ================= TTS FIX FINAL (WA COMPATIBLE) ================= */
            if (text.startsWith('.tts ')) {
                await react("🕒")
                const query = text.replace('.tts ', '').trim()
                if (!query) return sock.sendMessage(from, { text: "❌ Masukkan teks" })

                const input = "./tts.mp3"
                const output = "./tts.ogg"

                try {
                    // 🔥 ambil suara dari API
                    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=id&client=tw-ob&q=${encodeURIComponent(query)}`

                    const res = await axios.get(url, {
                        responseType: 'arraybuffer',
                        headers: {
                            'User-Agent': 'Mozilla/5.0'
                        },
                        timeout: 10000
                    })

                    fs.writeFileSync(input, res.data)

                    // 🔥 convert ke OGG OPUS (WA format)
                    await new Promise((resolve, reject) => {
                        ffmpeg(input)
                            .audioCodec("libopus")
                            .format("ogg")
                            .save(output)
                            .on("end", resolve)
                            .on("error", reject)
                    })

                    const audio = fs.readFileSync(output)

                    await sock.sendMessage(from, {
                        audio: audio,
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true
                    })

                } catch (err) {
                    console.log("TTS ERROR:", err)

                    try {
                        // 🔥 fallback streamelements
                        const audio = await textToVoice(query)

                        if (audio) {
                            fs.writeFileSync(input, audio)

                            await new Promise((resolve, reject) => {
                                ffmpeg(input)
                                    .audioCodec("libopus")
                                    .format("ogg")
                                    .save(output)
                                    .on("end", resolve)
                                    .on("error", reject)
                            })

                            const fix = fs.readFileSync(output)

                            await sock.sendMessage(from, {
                                audio: fix,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true
                            })
                        } else {
                            throw "fallback gagal"
                        }

                    } catch {
                        return sock.sendMessage(from, { text: "❌ TTS gagal total" })
                    }

                } finally {
                    if (fs.existsSync(input)) fs.unlinkSync(input)
                    if (fs.existsSync(output)) fs.unlinkSync(output)
                }
            }

            /* ================= BRAT MAX FIT PERFECT ================= */
            if (text.startsWith(".brat ")) {
                react("🕒")
                const input = text.replace(".brat ", "")

                let parts = input.split("|")

                let topText = parts[0] ? parts[0].trim() : ""
                let midText = parts[1] ? parts[1].trim() : ""
                let bottomText = parts[2] ? parts[2].trim() : ""

                function wrapText(ctx, text, maxWidth) {
                    const words = text.split(" ")
                    let lines = []
                    let line = ""

                    for (let n = 0; n < words.length; n++) {
                        const testLine = line + words[n] + " "
                        const width = ctx.measureText(testLine).width

                        if (width > maxWidth && n > 0) {
                            lines.push(line.trim())
                            line = words[n] + " "
                        } else {
                            line = testLine
                        }
                    }

                    lines.push(line.trim())
                    return lines
                }

                function getMaxFont(ctx, text, boxWidth, boxHeight) {
                    let fontSize = 120
                    let lines = []
                    while (fontSize > 10) {
                        ctx.font = `900 ${fontSize}px sans-serif`
                        lines = wrapText(ctx, text, boxWidth)
                        const lineHeight = fontSize * 1.2
                        const totalHeight = lines.length * lineHeight
                        if (!lines.some(line => ctx.measureText(line).width > boxWidth) && totalHeight <= boxHeight) break
                        fontSize -= 2
                    }
                    return { fontSize, lines }
                }

                function drawBlock(ctx, text, centerY) {
                    if (!text) return
                    const { fontSize, lines } = getMaxFont(ctx, text, 460, 150)
                    ctx.font = `900 ${fontSize}px sans-serif`
                    ctx.fillStyle = "black"; ctx.textAlign = "center"
                    const lineHeight = fontSize * 1.2
                    const totalHeight = lines.length * lineHeight
                    let startY = centerY - (totalHeight / 2) + lineHeight
                    lines.forEach((line, i) => ctx.fillText(line, 256, startY + (i * lineHeight)))
                }

                try {
                    const canvas = createCanvas(512, 512)
                    const ctx = canvas.getContext("2d")

                    // background putih
                    ctx.fillStyle = "white"
                    ctx.fillRect(0, 0, 512, 512)

                    // 🔥 FULL AREA TERBAGI 3 BAGIAN
                    drawBlock(ctx, topText, 90)
                    drawBlock(ctx, midText, 256)
                    drawBlock(ctx, bottomText, 420)

                    const buffer = canvas.toBuffer("image/png")

                    const webp = await sharp(buffer)
                        .webp()
                        .toBuffer()

                    await react("🖼️")
                    return sock.sendMessage(from, { sticker: webp })

                } catch (err) {
                    console.log(err)
                    await react("❌")
                    return sock.sendMessage(from, { text: "❌ Gagal membuat stiker (canvas error)" })
                }
            }

            /* ================= VIDEO → MP3 ================= */
            if ((type === 'videoMessage' && text === '.mp3') || text === '.toaudio') {
                await react("🕒")
                await react("🎵")
                const stream = await downloadContentFromMessage(body.videoMessage, "video")
                const buffer = await bufferFromStream(stream)
                const input = path.join(__dirname, "input.mp4")
                const output = path.join(__dirname, "output.mp3")
                fs.writeFileSync(input, buffer)
                try {
                    await videoToAudio(input, output)
                    const audio = fs.readFileSync(output)
                    await react("✅")
                    await sock.sendMessage(from, { audio, mimetype: "audio/mpeg" })
                } catch {
                    await react("❌")
                    await sock.sendMessage(from, { text: "❌ Gagal convert audio" })
                } finally {
                    if (fs.existsSync(input)) fs.unlinkSync(input)
                    if (fs.existsSync(output)) fs.unlinkSync(output)
                }
            }

            /* ================= TIKTOK ================= */
            if (text.startsWith('.tiktok ')) {
                await react("🕒")
                await react("🎬")
                const url = text.replace('.tiktok ', '')

                try {
                    const res = await axios.get(`https://tikwm.com/api/?url=${url}`, { timeout: 10000 })
                    const video = res.data.data.play

                    const vid = await axios.get(video, { responseType: 'arraybuffer', timeout: 20000 })

                    await react("✅")
                    await sock.sendMessage(from, {
                        video: vid.data,
                        caption: '✅ TikTok berhasil di download 𝗕̢͎ͨ̄𝘆̧̘͖̐𝗙̲͍̄̉͡𝗶͕̚͝𝗶͖̍͒͜'
                    })
                } catch {
                    await react("❌")
                    await sock.sendMessage(from, { text: '❌ Gagal download TikTok' })
                }
            }

        } catch (err) { console.log("❌ ERROR:", err) }
    })
}

startBot()
