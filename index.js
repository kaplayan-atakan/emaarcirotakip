const express = require('express');
const schedule = require('node-schedule');
const axios = require('axios');
const sql = require('mssql');
const path = require('path');
const session = require('express-session');
const nodemailer = require('nodemailer');
const { sendErrorEmail: centralSendErrorEmail } = require('./alerting');
const ActiveDirectory = require('activedirectory2');

// 📊 Aylık işlemler modülü
const monthlyOperations = require('./monthly-operations');

const app = express();

// 🔄 Bağlantı Pool Yönetimi
let dwhConnectionPool;
let restoConnectionPool;

// Graceful shutdown - Windows Service için optimize
process.on('SIGINT', async () => {
    console.log('📝 SIGINT received: gracefully shutting down from SIGINT (Ctrl-C)');
    await closeConnectionPools();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('📝 SIGTERM received: gracefully shutting down from SIGTERM');
    await closeConnectionPools();
    process.exit(0);
});

// Windows Service için ek event listeners
process.on('SIGHUP', async () => {
    console.log('📝 SIGHUP received: gracefully shutting down from SIGHUP');
    await closeConnectionPools();
    process.exit(0);
});

// Windows'a özel process events
if (process.platform === 'win32') {
    process.on('message', async (msg) => {
        if (msg === 'shutdown') {
            console.log('📝 Windows Service shutdown message received');
            await closeConnectionPools();
            process.exit(0);
        }
    });
}

// Service başlatıldığında log
console.log('🚀 Emaar Ciro Sistemi başlatıldı');  
console.log(`📊 Process ID: ${process.pid}`);
console.log(`🖥️ Platform: ${process.platform}`);
console.log(`📁 Working Directory: ${process.cwd()}`);


// DWH bağlantı pool'u
const dwhConfig = {
    user: 'basar.sonmez',
    password: 'RB&?L9apz',
    server: '10.200.200.5',
    port: 33336,
    database: 'DWH',
    pool: {
        max: 5,
        min: 1,
        idleTimeoutMillis: 300000,
        acquireTimeoutMillis: 60000,
        createTimeoutMillis: 30000,
        destroyTimeoutMillis: 5000,
        reapIntervalMillis: 60000,
        createRetryIntervalMillis: 2000
    },
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 60000,
        cancelTimeout: 10000,
        packetSize: 4096,
        appName: 'EmaarCiroSistemi-DWH',
        maxRetriesOnFailure: 3,
        multipleActiveResultSets: false
    }
};

// RESTO_16 bağlantı pool'u
const restoConfig = {
    user: 'basar.sonmez',
    password: 'RB&?L9apz',
    server: '172.16.14.2',
    database: 'RESTO_16',
    pool: {
        max: 8,
        min: 2,
        idleTimeoutMillis: 300000,
        acquireTimeoutMillis: 60000,
        createTimeoutMillis: 30000,
        destroyTimeoutMillis: 5000,
        reapIntervalMillis: 60000,
        createRetryIntervalMillis: 2000
    },
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 60000,
        cancelTimeout: 10000,
        packetSize: 4096,
        appName: 'EmaarCiroSistemi-RESTO',
        maxRetriesOnFailure: 3,
        multipleActiveResultSets: false
    }
};

// 🚀 Bağlantı pool'larını başlat
async function initializeConnectionPools() {
    try {
        console.log('🔄 Bağlantı pool\'ları başlatılıyor...');

        // DWH pool
        dwhConnectionPool = new sql.ConnectionPool(dwhConfig);
        await dwhConnectionPool.connect();
        console.log('✅ DWH bağlantı pool\'u hazır');

        // RESTO pool
        restoConnectionPool = new sql.ConnectionPool(restoConfig);
        await restoConnectionPool.connect();
        console.log('✅ RESTO bağlantı pool\'u hazır');

        console.log('🚀 Tüm bağlantı pool\'ları başarıyla başlatıldı');
    } catch (err) {
        console.error('❌ Bağlantı pool başlatma hatası:', err);
        process.exit(1);
    }
}

// 🔄 Bağlantı pool'larını temizle
async function closeConnectionPools() {
    try {
        if (dwhConnectionPool) {
            await dwhConnectionPool.close();
            console.log('🔒 DWH bağlantı pool\'u kapatıldı');
        }
        if (restoConnectionPool) {
            await restoConnectionPool.close();
            console.log('🔒 RESTO bağlantı pool\'u kapatıldı');
        }
    } catch (err) {
        console.error('❌ Bağlantı pool kapatma hatası:', err);
    }
}

// 📋 Express ayarları
app.use(express.urlencoded({
    extended: true,
    limit: '10mb',
    parameterLimit: 1000
}));

app.use(express.json({
    limit: '10mb',
    strict: true
}));

// 🍪 Session yapılandırması
app.use(session({
    secret: 'emaar-local-network-secret-2025-v2',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        secure: false,  // HTTP için false
        httpOnly: true,
        maxAge: 8 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'emaar.session.v2',
    store: new session.MemoryStore({
        checkPeriod: 900000
    })
}));

// 🏢 Active Directory yapılandırması - sadece bağlantı bilgileri
const adConfig = {
    url: 'ldap://10.200.200.10:389',
    baseDN: 'dc=baydoner,dc=local',

    attributes: {
        user: ['sAMAccountName', 'mail', 'displayName', 'department', 'title'],
        group: ['cn', 'description']
    },

    reconnect: {
        initialDelay: 100,
        maxDelay: 30000,
        failAfter: 5
    },

    timeout: 30000,
    connectTimeout: 10000,
    idleTimeout: 300000,

    tlsOptions: {
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined
    }
};

// 👥 İzin verilen kullanıcı adları listesi
const ALLOWED_USERS = [
    'atakan.kaplayan@apazgroup.com',
    'asli.senankesekler@apazgroup.com',
    'simge.civgin@apazgroup.com',
    'pinar.eraslan@apazgroup.com',
    'harun.ozdemir@apazgroup.com'
];

// 🔍 Kullanıcı adı kontrolü fonksiyonu
function isUserAllowed(username) {
    // Kullanıcı adını normalize et
    const normalizedUsername = username.toLowerCase().trim();

    // İzin verilen kullanıcılar listesinde kontrol et
    return ALLOWED_USERS.some(allowedUser => {
        const normalizedAllowed = allowedUser.toLowerCase().trim();
        return normalizedUsername === normalizedAllowed ||
            normalizedUsername === normalizedAllowed.split('@')[0];
    });
}

// AD Authentication - kullanıcı bilgilerini parametre olarak al
async function authenticateAD(username, password) {
    return new Promise((resolve, reject) => {
        // Önce kullanıcı adı kontrolü yap
        if (!isUserAllowed(username)) {
            console.log(`❌ Unauthorized user attempt: ${username}`);
            resolve(false);
            return;
        }

        // Her authentication için yeni AD instance oluştur
        const userAdConfig = {
            ...adConfig,
            username: username.includes('@') ? username : `${username}@baydoner.local`,
            password: password
        };

        const ad = new ActiveDirectory(userAdConfig);

        // Username'i normalize et
        const normalizedUsername = username.includes('@') ? username : `${username}@baydoner.local`;

        console.log(`🔐 AD Authentication attempt for: ${normalizedUsername}`);

        ad.authenticate(normalizedUsername, password, (err, auth) => {
            if (err) {
                console.log('❌ AD Auth Error:', err);
                resolve(false);
                return;
            }

            if (auth) {
                console.log('✅ AD Authentication successful for:', normalizedUsername);
                resolve(true);
            } else {
                console.log('❌ AD Authentication failed for:', normalizedUsername);
                resolve(false);
            }
        });
    });
}

// 📁 Statik dosya sunumu - index.html çakışmasını önle
app.use('/static', express.static(path.join(__dirname), {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    immutable: false,

    dotfiles: 'ignore',
    extensions: ['css', 'js', 'png', 'jpg', 'gif', 'ico', 'svg', 'woff', 'woff2'],
    fallthrough: true,
    redirect: false,

    index: false, // index.html'yi otomatik serve etme

    setHeaders: (res, filePath, stat) => {
        // index.html dosyasını engelle
        if (filePath.endsWith('index.html')) {
            res.status(404).end();
            return;
        }

        if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        }

        if (filePath.match(/\.(png|jpg|jpeg|gif|ico|svg)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000');
        }

        if (filePath.match(/\.(woff|woff2|ttf|eot)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
        }
    }
}));

// API Endpoints
const API_URL = "https://api.emaar.com/emaar/trky/sales";
const API_HEADERS = {
    "x-api-key": "g1LP2jMp65",
    "Content-Type": "application/json"
};

// 📊 Monthly modülüne konfigürasyonları aktar
monthlyOperations.setConfig(dwhConfig, restoConfig, API_URL, API_HEADERS);
// Merkezi hata bildirimi fonksiyonunu aylık modüle enjekte et
// (Hoisted function declaration olduğundan aşağıdaki wrapper'ı kullanabilir)
monthlyOperations.setErrorNotifier(sendErrorEmail);

// Authentication functions
async function authenticateAD(username, password) {
    return new Promise((resolve, reject) => {
        // Önce kullanıcı adı kontrolü yap
        if (!isUserAllowed(username)) {
            console.log(`❌ Unauthorized user attempt: ${username}`);
            resolve(false);
            return;
        }

        // Her authentication için yeni AD instance oluştur
        const userAdConfig = {
            ...adConfig,
            username: username.includes('@') ? username : `${username}@baydoner.local`,
            password: password
        };

        const ad = new ActiveDirectory(userAdConfig);

        // Username'i normalize et
        const normalizedUsername = username.includes('@') ? username : `${username}@baydoner.local`;

        console.log(`🔐 AD Authentication attempt for: ${normalizedUsername}`);

        ad.authenticate(normalizedUsername, password, (err, auth) => {
            if (err) {
                console.log('❌ AD Auth Error:', err);
                resolve(false);
                return;
            }

            if (auth) {
                console.log('✅ AD Authentication successful for:', normalizedUsername);
                resolve(true);
            } else {
                console.log('❌ AD Authentication failed for:', normalizedUsername);
                resolve(false);
            }
        });
    });
}

function requireLogin(req, res, next) {
    if (req.session.login === "z9x1v7b2" || req.session.adUser) {
        next();
    } else {
        res.redirect('/');
    }
}

async function gonderimDurum(tarih) {
    let pool;
    try {
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();

        // 🔍 DÜZELTME: personelLog tablosundan statuscode = 201 kontrolü
        const query = `
            SELECT TOP 1 
                pl.statuscode,
                pl.tarih as logTarihi,
                pl.veri3 as tarih,
                pl.kullanici
            FROM basar.personelLog pl
            WHERE pl.veri3 = @tarih
            AND pl.statuscode = 201
            AND pl.tablo = 'ciro'
            ORDER BY pl.tarih DESC
        `;

        const result = await pool.request()
            .input('tarih', sql.VarChar, tarih)
            .query(query);

        if (result.recordset.length > 0) {
            const record = result.recordset[0];
            return {
                exists: true,
                sent: true, // statuscode = 201 means successfully sent
                record_id: null,
                sent_date: record.logTarihi,
                created_date: record.logTarihi
            };
        }

        // 🔁 GERİYE DÖNÜK UYUMLULUK: Eski kayıtlar farklı (gun.ay.yil veya ay.gun.yil) formatında olabilir.
        // Eğer ilk sorgu sonuç vermediyse ve tarih pattern'i dd.mm.yyyy ise ay/gün swap edilerek tekrar denenir.
        if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(tarih)) {
            const [p1, p2, y] = tarih.split('.');
            // Eğer ilk iki parça farklı ve biri 12'den büyükse swap denemek mantıklı (örn 13.01.2025 -> 01.13.2025 anlamsız, bu yüzden >12 kontrolü)
            // Ancak eski bug ay-gün tersliği ise (03.07.2025 yerine 07.03.2025) her iki parça da <=12 olabilir; bu durumda yine de bir deneme yapılabilir.
            const swapped = `${p2.padStart(2,'0')}.${p1.padStart(2,'0')}.${y}`;
            if (swapped !== tarih) {
                const altResult = await pool.request()
                    .input('tarih', sql.VarChar, swapped)
                    .query(query);
                if (altResult.recordset.length > 0) {
                    const record = altResult.recordset[0];
                    return {
                        exists: true,
                        sent: true,
                        record_id: null,
                        sent_date: record.logTarihi,
                        created_date: record.logTarihi,
                        note: 'alternate_date_format_match',
                        matched_format: swapped
                    };
                }
            }
        }

        return {
            exists: false,
            sent: false,
            record_id: null,
            sent_date: null,
            created_date: null
        };

    } catch (err) {
        console.error('❌ Gonderim durum check error:', err);
        return {
            exists: false,
            sent: false,
            record_id: null,
            sent_date: null,
            created_date: null,
            error: err.message
        };
    } finally {
        if (pool) {
            await pool.close();
        }
    }
}

// Email gönderme fonksiyonu
async function sendEmail(ciro, kisi, tarih, kullanici) {
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 25,
        secure: false,
        auth: {
            user: 'alert@apazgroup.com',
            pass: 'dxvybfdrbtfpfbfl'
        }
    });

    let kullaniciTipi = '';
    let kullaniciAdi = kullanici;
    let emailTo = 'atakan.kaplayan@apazgroup.com';

    if (kullanici.startsWith('AD:')) {
        kullaniciTipi = '🏢 Active Directory';
        kullaniciAdi = kullanici.replace('AD:', '').trim();
        emailTo = `${kullaniciAdi}`;
    } else if (kullanici.includes('Sistem Kullanıcısı')) {
        kullaniciTipi = '🔑 Sistem Girişi';
        kullaniciAdi = 'Basit Login';
    } else {
        kullaniciTipi = '❓ Bilinmeyen';
        kullaniciAdi = kullanici;
    }

      const mailOptions = {
        from: '"Apaz Group Info" <alert@apazgroup.com>',
        to: emailTo,
        cc: "asli.senankesekler@apazgroup.com, simge.civgin@apazgroup.com, pinar.eraslan@apazgroup.com",
        subject: `📊 Emaar Ciro Gönderimi - ${tarih}`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa; padding: 20px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 10px 10px 0 0; text-align: center;">
                    <h2 style="margin: 0; font-size: 24px; color: #000000;">📊 Emaar Ciro Verisi Gönderildi</h2>
                </div>
                
                <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <div style="border-left: 4px solid #667eea; padding-left: 20px; margin-bottom: 25px;">
                        <h3 style="color: #333; margin: 0 0 15px 0;">📈 Gönderilen Veriler</h3>
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr style="border-bottom: 1px solid #eee;">
                                <td style="padding: 10px 0; font-weight: 600; color: #555; width: 40%;">📅 Tarih:</td>
                                <td style="padding: 10px 0; color: #333;">${tarih}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #eee;">
                                <td style="padding: 10px 0; font-weight: 600; color: #555;">💰 Ciro:</td>
                                <td style="padding: 10px 0; color: #333; font-weight: 600;">${ciro} ₺</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #eee;">
                                <td style="padding: 10px 0; font-weight: 600; color: #555;">👥 Kişi Sayısı:</td>
                                <td style="padding: 10px 0; color: #333;">${kisi}</td>
                            </tr>
                        </table>
                    </div>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #28a745;">
                        <h3 style="color: #333; margin: 0 0 15px 0;">👤 Gönderen Bilgileri</h3>
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 8px 0; font-weight: 600; color: #555; width: 40%;">Giriş Tipi:</td>
                                <td style="padding: 8px 0; color: #333;">${kullaniciTipi}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 8px 0; font-weight: 600; color: #555;">Kullanıcı:</td>
                                <td style="padding: 8px 0; color: #333; font-weight: 600;">${kullaniciAdi}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; font-weight: 600; color: #555;">🕐 Gönderim Zamanı:</td>
                                <td style="padding: 8px 0; color: #333;">${new Date().toLocaleString('tr-TR')}</td>
                            </tr>
                        </table>
                    </div>
                    
                    <div style="margin-top: 25px; padding: 15px; background: #e7f3ff; border-radius: 8px; border-left: 4px solid #007bff;">
                        <p style="margin: 0; color: #0056b3; font-size: 14px;">
                            ℹ️ <strong>Bilgi:</strong> Bu veri otomatik olarak Emaar API'sine gönderilmiştir.
                        </p>
                    </div>
                </div>
                
                <div style="text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px;">
                    <p style="margin: 0;">Bu email otomatik olarak sistem tarafından gönderilmiştir.</p>
                    <p style="margin: 5px 0 0 0;">Apaz Group © ${new Date().getFullYear()}</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧✅ Email başarıyla gönderildi: ${kullaniciAdi} (${kullaniciTipi}) tarafından ${tarih} tarihli veri gönderimi`);
    } catch (error) {
        console.error('📧❌ Email gönderim hatası:', error);
    }
}

// ❗ Merkezileştirilmiş hata email wrapper (geriye uyumluluk için aynı isim)
async function sendErrorEmail(args) { return centralSendErrorEmail(args); }

// Routes

// Ana sayfa
app.get('/', async (req, res) => {
    if (!req.session.login && !req.session.adUser) {
        // Login formu göster
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Login - Emaar Ciro Sistemi</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    body { 
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        padding: 20px;
                    }
                    .login-container { 
                        max-width: 400px; 
                        width: 100%;
                        background: white;
                        border-radius: 15px;
                        box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                        overflow: hidden;
                        animation: slideUp 0.5s ease-out;
                    }
                    @keyframes slideUp {
                        from {
                            opacity: 0;
                            transform: translateY(30px);
                        }
                        to {
                            opacity: 1;
                            transform: translateY(0);
                        }
                    }
                    .login-header {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        padding: 30px;
                        text-align: center;
                    }
                    .login-header h2 {
                        font-size: 24px;
                        font-weight: 600;
                        margin-bottom: 5px;
                    }
                    .login-header p {
                        opacity: 0.9;
                        font-size: 14px;
                    }
                    .login-body {
                        padding: 30px;
                    }
                    .login-tabs {
                        display: flex;
                        margin-bottom: 25px;
                        border-radius: 8px;
                        background: #f8f9fa;
                        padding: 4px;
                    }
                    .tab {
                        flex: 1;
                        padding: 12px;
                        text-align: center;
                        background: transparent;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-weight: 500;
                        transition: all 0.3s;
                        color: #6c757d;
                    }
                    .tab.active {
                        background: white;
                        color: #667eea;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                    }
                    .tab-content {
                        display: none;
                    }
                    .tab-content.active {
                        display: block;
                    }
                    input[type="text"], input[type="password"] { 
                        width: 100%; 
                        padding: 15px; 
                        margin: 10px 0; 
                        border: 2px solid #e9ecef;
                        border-radius: 8px;
                        font-size: 14px;
                        box-sizing: border-box;
                        transition: border-color 0.3s, box-shadow 0.3s;
                    }
                    input[type="text"]:focus, input[type="password"]:focus {
                        outline: none;
                        border-color: #667eea;
                        box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                    }
                    .btn { 
                        width: 100%; 
                        padding: 15px; 
                        margin: 15px 0 10px 0; 
                        border: none; 
                        border-radius: 8px;
                        font-size: 14px;
                        font-weight: 600;
                        cursor: pointer;
                        box-sizing: border-box;
                        transition: all 0.3s;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .btn-primary {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                    }
                    .btn-primary:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
                    }
                    .btn-ad {
                        background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
                        color: white;
                    }
                    .btn-ad:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 8px 25px rgba(40, 167, 69, 0.3);
                    }
                    .divider {
                        text-align: center;
                        margin: 20px 0;
                        position: relative;
                        color: #6c757d;
                    }
                    .divider::before {
                        content: '';
                        position: absolute;
                        top: 50%;
                        left: 0;
                        right: 0;
                        height: 1px;
                        background: #dee2e6;
                    }
                    .divider span {
                        background: white;
                        padding: 0 15px;
                    }
                    .form-group {
                        margin-bottom: 15px;
                    }
                    .form-group label {
                        display: block;
                        margin-bottom: 5px;
                        color: #495057;
                        font-weight: 500;
                    }
                    .icon {
                        margin-right: 8px;
                    }
                    @media (max-width: 480px) {
                        .login-container {
                            margin: 10px;
                        }
                        .login-header {
                            padding: 20px;
                        }
                        .login-body {
                            padding: 20px;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="login-container">
                    <div class="login-header">
                        <h2>🏢 Emaar Ciro Sistemi</h2>
                        <p>Ciro ve Kişi Sayısı Yönetimi</p>
                    </div>
                    <div class="login-body">
                        <div class="login-tabs">
                            <button class="tab active" onclick="switchTab('simple')">
                                <span class="icon">🔑</span> Basit Giriş
                            </button>
                            <button class="tab" onclick="switchTab('ad')">
                                <span class="icon">🏢</span> AD Giriş
                            </button>
                        </div>

                        <!-- Simple Login -->
                        <div id="simple-login" class="tab-content active">
                            <form method="post" action="/login">
                                <div class="form-group">
                                    <label for="password">Sistem Şifresi</label>
                                    <input type="password" id="password" name="upp" placeholder="Şifrenizi girin" required>
                                </div>
                                <button type="submit" class="btn btn-primary">
                                    <span class="icon">🚀</span> Giriş Yap
                                </button>
                            </form>
                        </div>

                        <!-- AD Login -->
                        <div id="ad-login" class="tab-content">
                            <form method="post" action="/ad-login">
                                <div class="form-group">
                                    <label for="username">Kullanıcı Adı</label>
                                    <input type="text" id="username" name="username" placeholder="kullaniciadi@apazgroup.com" required>
                                </div>
                                <div class="form-group">
                                    <label for="ad-password">Active Directory Şifre</label>
                                    <input type="password" id="ad-password" name="password" placeholder="AD şifrenizi girin" required>
                                </div>
                                <button type="submit" class="btn btn-ad">
                                    <span class="icon">🏢</span> AD ile Giriş Yap
                                </button>
                            </form>
                        </div>
                    </div>
                </div>

                <div id="spinner" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:9999;">
                    <div style="width:50px; height:50px; border:5px solid #f3f3f3; border-top:5px solid #3498db; border-radius:50%; animation:spin 1s linear infinite;"></div>
                </div>

                <style>
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>

                <script>
                    function switchTab(tabName) {
                        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                        
                        event.target.classList.add('active');
                        document.getElementById(tabName + '-login').classList.add('active');
                    }

                    document.querySelectorAll('form').forEach(form => {
                        form.addEventListener('submit', function(e) {
                            const inputs = this.querySelectorAll('input[required]');
                            let isValid = true;
                            
                            inputs.forEach(input => {
                                if (!input.value.trim()) {
                                    input.style.borderColor = '#dc3545';
                                    isValid = false;
                                } else {
                                    input.style.borderColor = '#e9ecef';
                                }
                            });
                            
                            if (!isValid) {
                                e.preventDefault();
                                alert('Lütfen tüm alanları doldurun.');
                            } else {
                                document.getElementById('spinner').style.display = 'block';
                            }
                        });
                    });
                </script>
            </body>
            </html>
        `);
    } else {
        // Veri listesi göster
        let dwhPool;
        try {
            dwhPool = new sql.ConnectionPool(dwhConfig);
            await dwhPool.connect();

            const result = await dwhPool.request()
                .query("SELECT TOP 50 * FROM [DWH].[dbo].[FactKisiSayisiCiro] WHERE [Şube Kodu] = 17672 ORDER BY CONVERT(datetime,Tarih,104) DESC"); let tableRows = ''; for (const row of result.recordset) {
                    let ciro = parseFloat(row.Ciro).toFixed(2);
                    let kisi = row["Kişi Sayısı"];
                    const tarih = row.Tarih;

                    // TARİH NORMALİZASYONU: Uygulama genelinde DD.MM.YYYY kullan
                    // 🔍 Gönderilmiş veri kontrolü (ARTIK normalizasyon YOK - ham DWH tarih değeri kullanılır)
                    const durumKontrol = await gonderimDurum(tarih);
                    const isGonderilmis = durumKontrol.sent;
                    // ✅ Eğer gönderilmişse, personelLog'daki ciro ve kişi değerlerini kullan
                    if (isGonderilmis) {
                        try {
                            const logPool = new sql.ConnectionPool(restoConfig);
                            await logPool.connect();

                            const logResult = await logPool.request()
                                .input('tarih', sql.VarChar, tarih)
                                .query(`
                                SELECT TOP 1 
                                    veri1 as sentCiro,
                                    veri2 as sentKisi 
                                FROM basar.personelLog 
                                WHERE veri3 = @tarih 
                                AND statuscode = 201 
                                AND tablo = 'ciro'
                                ORDER BY tarih DESC
                            `);

                            if (logResult.recordset.length > 0) {
                                const sentCiro = logResult.recordset[0].sentCiro;
                                const sentKisi = logResult.recordset[0].sentKisi;

                                if (sentCiro && !isNaN(parseFloat(sentCiro))) {
                                    ciro = parseFloat(sentCiro).toFixed(2);
                                }
                                if (sentKisi && !isNaN(parseInt(sentKisi))) {
                                    kisi = parseInt(sentKisi);
                                }
                            }

                            await logPool.close();
                        } catch (logError) {
                            console.error('PersonelLog verisi okuma hatası:', logError.message);
                        }
                    }

                    // Gelişmiş durum (son deneme / overall başarı)
                    const detay = await gonderimDurumDetay(tarih);
                    let statusBadge = '';
                    if (detay.error) {
                        statusBadge = `<span style=\"background:#dc354520;color:#dc3545;padding:2px 6px;border-radius:6px;font-size:11px;\">ERR</span>`;
                    } else if (detay.neverSent) {
                        statusBadge = `<span style=\"background:#6c757d20;color:#6c757d;padding:2px 6px;border-radius:6px;font-size:11px;\">YOK</span>`;
                    } else if (detay.onlyFailures) {
                        statusBadge = `<span style=\"background:#b91c1c20;color:#b91c1c;padding:2px 6px;border-radius:6px;font-size:11px;\">FAIL</span>`;
                    } else if (detay.degraded) {
                        statusBadge = `<span title=\"Önce başarı sonra hata (son: ${detay.lastStatusCode})\" style=\"background:#d9770620;color:#d97706;padding:2px 6px;border-radius:6px;font-size:11px;\">DEG</span>`;
                    } else if (detay.lastIsSuccess) {
                        statusBadge = `<span style=\"background:#19875420;color:#198754;padding:2px 6px;border-radius:6px;font-size:11px;\">OK</span>`;
                    } else {
                        statusBadge = `<span style=\"background:#6c757d20;color:#6c757d;padding:2px 6px;border-radius:6px;font-size:11px;\">?${detay.lastStatusCode||''}</span>`;
                    }
                    const buttonClass = detay.lastIsSuccess ? 'btn-success' : 'btn-danger';
                    const buttonText = detay.lastIsSuccess ? 'Yeniden Gönder' : 'Gönder';

                    tableRows += `
                    <tr>
                        <td>
                            <form method="post" action="/send" style="display:inline;">
                                <input type="number" name="ciro" value="${ciro}" step="0.01" style="width: 100px; padding: 5px;" required>
                        </td>
                        <td>
                                <input type="number" name="kisi" value="${kisi}" style="width: 80px; padding: 5px;" required>
                        </td>
                        <td>
                                <input type="text" name="tarih" value="${tarih}" readonly style="width: 100px; padding: 5px; background: #f5f5f5;">
                        </td>
            <td style="text-align:center;">${statusBadge}</td>
            <td>
                <button type="submit" class="${buttonClass}" style="padding: 8px 12px;">${buttonText}</button>
                                
                            </form>
                        </td>
                    </tr>
                `;
                }

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Ciro ve Kişi Sayısı Gönderim</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }
                        body { 
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                            background-color: #f8f9fa;
                            padding: 20px;
                            color: #333;
                        }
                        .container {
                            max-width: 1200px;
                            margin: 0 auto;
                            background: white;
                            border-radius: 10px;
                            box-shadow: 0 2px 20px rgba(0,0,0,0.1);
                            overflow: hidden;
                        }
                        .header {
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            padding: 20px 30px;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        }
                        .header h1 {
                            font-size: 24px;
                            font-weight: 600;
                        }
                        .logout {
                            background: rgba(255,255,255,0.2);
                            color: white;
                            text-decoration: none;
                            padding: 8px 16px;
                            border-radius: 5px;
                            transition: background 0.3s;
                        }
                        .logout:hover {
                            background: rgba(255,255,255,0.3);
                            color: white;
                            text-decoration: none;
                        }
                        .table-container {
                            padding: 20px;
                            overflow-x: auto;
                        }
                        table { 
                            width: 100%; 
                            border-collapse: collapse;
                            margin: 0;
                        }
                        th {
                            background: #f8f9fa;
                            color: #495057;
                            font-weight: 600;
                            padding: 15px 10px;
                            text-align: left;
                            border-bottom: 2px solid #dee2e6;
                            font-size: 14px;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                        }
                        td { 
                            padding: 15px 10px;
                            border-bottom: 1px solid #dee2e6;
                            vertical-align: middle;
                        }
                        tr:hover {
                            background-color: #f8f9fa;
                        }
                        .btn-success { 
                            background: linear-gradient(135deg, #28a745, #20c997);
                            color: white; 
                            border: none; 
                            padding: 8px 16px; 
                            border-radius: 5px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: 500;
                            transition: all 0.3s;
                            min-width: 120px;
                        }
                        .btn-success:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 4px 12px rgba(40, 167, 69, 0.3);
                        }
                        .btn-danger { 
                            background: linear-gradient(135deg, #dc3545, #e83e8c);
                            color: white; 
                            border: none; 
                            padding: 8px 16px; 
                            border-radius: 5px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: 500;
                            transition: all 0.3s;
                            min-width: 120px;
                        }
                        .btn-danger:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 4px 12px rgba(220, 53, 69, 0.3);
                        }
                        input[type="number"], input[type="text"] { 
                            border: 2px solid #e9ecef;
                            border-radius: 5px;
                            padding: 8px 12px;
                            font-size: 14px;
                            width: 100%;
                            min-width: 80px;
                            transition: border-color 0.3s;
                        }
                        input[type="number"]:focus, input[type="text"]:focus {
                            outline: none;
                            border-color: #667eea;
                            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                        }
                        input[readonly] { 
                            background-color: #f8f9fa;
                            color: #6c757d;
                            cursor: not-allowed;
                        }
                        
                        /* Loading spinner styles */
                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                        
                        .spinner {
                            position: fixed;
                            top: 50%;
                            left: 50%;
                            transform: translate(-50%, -50%);
                            z-index: 9999;
                            background: rgba(255, 255, 255, 0.9);
                            border-radius: 10px;
                            padding: 20px;
                            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                        }
                        
                        .form-overlay {
                            position: relative;
                        }
                        
                        .form-overlay.loading {
                            pointer-events: none;
                            opacity: 0.7;
                        }
                        
                        .btn-loading {
                            position: relative;
                            pointer-events: none;
                            opacity: 0.7;
                        }
                        
                        @media (max-width: 768px) {
                            .header {
                                flex-direction: column;
                                gap: 10px;
                                text-align: center;
                            }
                            .header h1 {
                                font-size: 20px;
                            }
                            th, td {
                                padding: 10px 5px;
                                font-size: 13px;
                            }
                            input[type="number"], input[type="text"] {
                                min-width: 60px;
                                padding: 6px 8px;
                            }
                            .btn-success, .btn-danger {
                                padding: 6px 12px;
                                font-size: 12px;
                                min-width: 100px;
                            }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>Ciro ve Kişi Sayısı Gönderim</h1>
                            <a href="/logout" class="logout">Çıkış Yap</a>
                        </div>
                        
                        <!-- Tab Navigation -->
                        <!-- Early global stub to avoid ReferenceError if buttons clicked before main script execution -->
                        <script>window.showTab = window.showTab || function(tabName){try{var d=document.getElementById('daily-tab');var m=document.getElementById('monthly-tab');if(d)d.style.display='none';if(m)m.style.display='none';document.querySelectorAll('.tab-btn').forEach(function(btn){btn.style.borderBottomColor='transparent';btn.style.color='#6c757d';});var t=document.getElementById(tabName+'-tab');if(t)t.style.display='block';}catch(e){console.error('early showTab stub error',e);}};</script>
                        <div class="tab-navigation" style="margin-bottom: 20px; border-bottom: 2px solid #dee2e6;">
                            <button class="tab-btn active" onclick="window.showTab ? showTab('daily', event) : null" style="padding: 12px 24px; background: none; border: none; border-bottom: 3px solid #007bff; color: #007bff; font-weight: 600; cursor: pointer; margin-right: 10px;">📅 Günlük Gönderim</button>
                            <button class="tab-btn" onclick="window.showTab ? showTab('monthly', event) : null" style="padding: 12px 24px; background: none; border: none; border-bottom: 3px solid transparent; color: #6c757d; font-weight: 600; cursor: pointer;">📊 Aylık Rapor</button>
                        </div>
                        
                        <!-- Daily Tab Content -->
                        <div id="daily-tab" class="tab-content">
                            <div class="table-container">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Ciro (₺)</th>
                                            <th>Kişi Sayısı</th>
                                            <th>Tarih</th>
                                            <th>Durum</th>
                                            <th>İşlem</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${tableRows}
                                    </tbody>
                                </table>
                            </div>
                            <div style="margin-top:22px;">
                                <button onclick="toggleDailyLogDetails()" style="padding:10px 16px; background:#0d6efd; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:600; box-shadow:0 2px 6px rgba(0,0,0,0.15);">🔍 Detaylı Günlük Logları Göster</button>
                                <div id="dailyLogDetails" style="display:none; margin-top:14px; background:#f8f9fa; border:1px solid #e3e7ed; border-radius:10px; padding:16px; max-height:420px; overflow:auto; font-size:12.5px; line-height:1.4;"></div>
                            </div>
                        </div>
                        
                        <!-- Monthly Tab Content -->
                        <div id="monthly-tab" class="tab-content" style="display: none;">
                            <div style="background: white; border-radius: 12px; padding: 25px; margin-bottom: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                                <h2 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 20px; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
                                    📊 Aylık Ciro Raporu Gönderimi
                                </h2>
                                
                                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 20px;">
                                    <div>
                                        <label style="display: block; color: #495057; font-weight: 600; margin-bottom: 5px;">Yıl:</label>
                                        <select id="monthlyYil" style="width: 100%; padding: 10px; border: 2px solid #e9ecef; border-radius: 8px; background: white;">
                                            <option value="2025">2025</option>
                                            <option value="2024">2024</option>
                                            <option value="2023">2023</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label style="display: block; color: #495057; font-weight: 600; margin-bottom: 5px;">Ay:</label>
                                        <select id="monthlyAy" style="width: 100%; padding: 10px; border: 2px solid #e9ecef; border-radius: 8px; background: white;">
                                            <option value="1">Ocak</option>
                                            <option value="2">Şubat</option>
                                            <option value="3">Mart</option>
                                            <option value="4">Nisan</option>
                                            <option value="5">Mayıs</option>
                                            <option value="6">Haziran</option>
                                            <option value="7">Temmuz</option>
                                            <option value="8">Ağustos</option>
                                            <option value="9">Eylül</option>
                                            <option value="10">Ekim</option>
                                            <option value="11">Kasım</option>
                                            <option value="12">Aralık</option>
                                        </select>
                                    </div>
                                    <div style="display: flex; flex-direction: column; justify-content: end;">
                                        <button onclick="previewMonthlyData()" style="width: 100%; padding: 10px; background: linear-gradient(135deg, #17a2b8, #20c997); color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; margin-bottom: 5px;">
                                            🔍 Önizle
                                        </button>
                                        <button onclick="sendMonthlyData()" style="width: 100%; padding: 10px; background: linear-gradient(135deg, #28a745, #20c997); color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer;">
                                            📤 Gönder
                                        </button>
                                    </div>
                                </div>
                                
                                <!-- Özel Test Butonu (sadece atakan.kaplayan için) -->
                                ${ (req.session?.adUser && req.session.adUser.toLowerCase().startsWith('atakan.kaplayan')) ? `
                                <div style="margin: 15px 0 25px; padding:14px 16px; background:#fff8e1; border:1px solid #ffe8a3; border-radius:8px;">
                                    <div style="display:flex; flex-wrap:wrap; align-items:center; gap:12px; justify-content:space-between;">
                                        <div style="font-size:13px; color:#6c5500; line-height:1.4;">
                                            <strong>Test Aracı:</strong> Geçmiş ay için LOG bazlı günlük gönderilmiş verileri ve oluşturulacak aylık özet hesaplamasını tek ekranda inceleyebilirsiniz.
                                        </div>
                                        <script>
                                            // Early safe stub & resilient fallback for deep preview
                                            (function(){
                                                function defineFallback(){
                                                    if(window.__deepPreviewFallbackDefined) return; // idempotent
                                                    window.__deepPreviewFallbackFallbackTS = Date.now();
                                                    window.runLastMonthDeepPreview = async function(btn){
                                                        try {
                                                            const container = document.getElementById('deepPreviewResult');
                                                            if(!container){ return console.error('deepPreviewResult bulunamadı'); }
                                                            container.style.display='block';
                                                            container.innerHTML = '<em>Yükleniyor...</em>';
                                                            if(btn){ btn.disabled = true; var orig = btn.innerHTML; btn.innerHTML='Çalışıyor...'; }
                                                            const resp = await fetch('/monthly-last-month-deep-preview');
                                                            const data = await resp.json();
                                                            if(!data.success){ container.innerHTML = 'Hata: '+ data.message; return; }
                                                            const v = data.veri || {}; const dwh = data.dwh || {}; const ayAd=['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
                                                            let html = '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">📅 '+ ayAd[v.ay] +' '+ v.yil +' Derin Önizleme (Fallback)</div>';
                                                            html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px;">';
                                                            html += '<div style="background:#fff;padding:8px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Toplam Ciro</div><div style="font-weight:600;color:#1e8e3e;">'+ (v.toplamCiro||0).toLocaleString('tr-TR') +'₺</div></div>';
                                                            html += '<div style="background:#fff;padding:8px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Toplam Kişi</div><div style="font-weight:600;color:#1d5fbf;">'+ (v.toplamKisi||0).toLocaleString('tr-TR') +'</div></div>';
                                                            html += '<div style="background:#fff;padding:8px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Gönderilen Gün</div><div style="font-weight:600;">'+ (v.gunSayisi||0) +'</div></div>';
                                                            html += '<div style="background:#fff;padding:8px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Eksik Gün</div><div style="font-weight:600;color:' + ((v.eksikGunler||[]).length?'#d35400':'#16a34a') + ';">'+ (v.eksikGunler||[]).length +'</div></div>';
                                                            html += '</div>';
                                                            if((v.eksikGunler||[]).length){
                                                                html += '<div style="background:#fff3cd;border:1px solid #ffe69c;padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px;">Eksik Günler: '+ v.eksikGunler.join(', ') +'<br><button onclick="triggerAutoFillLastMonth(this)" style="margin-top:6px;padding:6px 10px;background:#ff9800;border:none;border-radius:5px;cursor:pointer;color:#222;font-weight:600;">⚙️ Auto-Fill</button></div>';
                                                            }
                                                            if(dwh && dwh.dwhToplamCiro !== undefined){
                                                                html += '<div style="font-size:12px;margin:6px 0 10px;">DWH Ciro: '+ Number(dwh.dwhToplamCiro).toLocaleString('tr-TR') +'₺ | LOG: '+ (v.toplamCiro||0).toLocaleString('tr-TR') +'₺ | Fark: '+ (dwh.farkCiro || '0') +' ('+ (dwh.farkYuzdeCiro||'0') +'%)</div>';
                                                            }
                                                            container.innerHTML = html;
                                                        } catch(e){
                                                            console.error('Fallback deep preview hata', e);
                                                            const c=document.getElementById('deepPreviewResult'); if(c) c.innerHTML='Hata: '+ e.message;
                                                        } finally { if(btn){ btn.disabled=false; btn.innerHTML='🧪 Geçmiş Ay Derin Önizleme'; } }
                                                    };
                                                    window.triggerAutoFillLastMonth = async function(btn){
                                                        try {
                                                            if(btn){ btn.disabled=true; var o=btn.innerHTML; btn.innerHTML='Çalışıyor...'; }
                                                            const resp = await fetch('/monthly-last-month-autofill-run',{method:'POST'});
                                                            const data = await resp.json();
                                                            alert(data.success ? 'Auto-Fill tamamlandı' : ('Auto-Fill hata: '+ data.message));
                                                            if(data.success){ window.runLastMonthDeepPreview(); }
                                                        } catch(e){ alert('Auto-Fill tetikleme hatası: '+ e.message); }
                                                        finally { if(btn){ btn.disabled=false; btn.innerHTML=o; }}
                                                    };
                                                    window.__deepPreviewFallbackDefined = true;
                                                }
                                                // tanımla ve sonra ana script geldi mi kontrol için 2 sn sonra tekrar test et
                                                defineFallback();
                                                setTimeout(function(){
                                                    // Eğer daha zengin (fetch içeren) bir implementasyon yüklendiyse (toString kontrol vs) dokunma
                                                    if(window.runLastMonthDeepPreview && window.runLastMonthDeepPreview.toString().indexOf('Derin Önizleme (Fallback)')>-1){
                                                        console.warn('Deep preview fallback aktif (ana script override etmedi).');
                                                    }
                                                },2000);
                                            })();
                                        </script>
                                        <button onclick="window.runLastMonthDeepPreview && runLastMonthDeepPreview(this)" style="padding:10px 18px; background:linear-gradient(135deg,#ff9800,#ffb74d); color:#222; font-weight:600; border:none; border-radius:8px; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.15);">🧪 Geçmiş Ay Derin Önizleme</button>
                                    </div>
                                    <div id="deepPreviewResult" style="margin-top:16px; display:none; background:#f8f9fa; border:1px solid #eceff3; border-radius:8px; padding:16px; max-height:480px; overflow:auto; font-size:12.5px; line-height:1.45;"></div>
                                </div>` : '' }

                                <!-- Preview Area -->
                                <div id="monthlyPreview" style="display: none; background: #f8f9fa; border-radius: 8px; padding: 20px; margin-top: 20px; border-left: 4px solid #17a2b8;">
                                    <!-- Preview content will be populated by JavaScript -->
                                </div>
                                
                                <!-- History Area -->
                                <div style="margin-top: 30px;">
                                    <h3 style="color: #495057; margin-bottom: 15px; font-size: 16px;">📋 Son Gönderimler</h3>
                                    <div id="monthlyHistory" style="max-height: 300px; overflow-y: auto;">
                                        <!-- History will be populated by JavaScript -->
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Global Loading Spinner -->
                    <div id="globalSpinner" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(255,255,255,0.9); z-index:9999;">
                        <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); text-align:center;">
                            <div style="width:50px; height:50px; border:5px solid #f3f3f3; border-top:5px solid #667eea; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 15px;"></div>
                            <p style="color:#667eea; font-weight:600; margin:0;">Gönderiliyor...</p>
                        </div>
                    </div>

                    <script>
                        // Global functions (accessible from onclick)
                        function showTab(tabName, ev) {
                            try {
                                // Hide all tabs
                                var daily = document.getElementById('daily-tab');
                                var monthly = document.getElementById('monthly-tab');
                                if (daily) daily.style.display = 'none';
                                if (monthly) monthly.style.display = 'none';
                                // Reset buttons
                                document.querySelectorAll('.tab-btn').forEach(function(btn){
                                    btn.style.borderBottomColor = 'transparent';
                                    btn.style.color = '#6c757d';
                                });
                                // Show requested
                                var targetDiv = document.getElementById(tabName + '-tab');
                                if (targetDiv) targetDiv.style.display = 'block';
                                var evt = ev || window.event;
                                var origin = (evt && evt.currentTarget) || (evt && evt.target);
                                if (origin) {
                                    origin.style.borderBottomColor = '#007bff';
                                    origin.style.color = '#007bff';
                                }
                            } catch(e) { console.error('showTab error', e); }
                        }
                        // Explicit global exposure (in case of scoping)
                        window.showTab = showTab;
                        
                        function showGlobalSpinner() {
                            const spinner = document.getElementById('globalSpinner');
                            if (spinner) spinner.style.display = 'flex';
                        }
                        
                        function hideGlobalSpinner() {
                            const spinner = document.getElementById('globalSpinner');
                            if (spinner) spinner.style.display = 'none';
                        }

                        // Günlük detay loglarını yükle/göster
                        let __dailyLogLoaded = false;
                        async function loadDailyLogDetails(){
                            const box = document.getElementById('dailyLogDetails');
                            if(!box) return;
                            box.innerHTML = '<em>Yükleniyor...</em>';
                            try{
                                const resp = await fetch('/daily-log-details');
                                const data = await resp.json();
                                if(!data.success){ box.innerHTML = 'Hata: '+ data.message; return; }
                                const rows = data.rows || [];
                                if(!rows.length){ box.innerHTML = '<em>Kayıt bulunamadı.</em>'; return; }
                                const statusBadge = sc => {
                                    const code = parseInt(sc,10);
                                    let clr='#6c757d', txt='?';
                                    if(code===201){ clr='#198754'; txt='OK'; }
                                    else if(code>=500){ clr='#b91c1c'; txt='ERR'; }
                                    else if(code>=400){ clr='#d97706'; txt='WARN'; }
                                    return '<span style="display:inline-block;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:600;background:'+clr+'20;color:'+clr+';">'+ txt +' '+ code +'</span>';
                                };
                                let html = '<table style="width:100%;border-collapse:collapse;">'+
                                    '<thead><tr style="background:#eef1f5;font-size:11px;text-align:left;">'+
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;">Log Zamanı</th>'+ 
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;">Gün</th>'+ 
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;text-align:right;">Ciro</th>'+ 
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;text-align:right;">Kişi</th>'+ 
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;">Status</th>'+ 
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;">Kullanıcı</th>'+ 
                                    '<th style="padding:4px 6px;border:1px solid #dfe3e8;">Cevap</th>'+ 
                                    '</tr></thead><tbody>';
                                html += rows.map(r => {
                                    return '<tr style="font-size:11.5px;">'+
                                        '<td style="padding:4px 6px;border:1px solid #eee;white-space:nowrap;">'+ new Date(r.logZamani).toLocaleString('tr-TR') +'</td>'+ 
                                        '<td style="padding:4px 6px;border:1px solid #eee;">'+ (r.gunTarihi||'') +'</td>'+ 
                                        '<td style="padding:4px 6px;border:1px solid #eee;text-align:right;color:#1e8e3e;">'+ (parseFloat(r.ciro||0).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2})) +'</td>'+ 
                                        '<td style="padding:4px 6px;border:1px solid #eee;text-align:right;color:#1d5fbf;">'+ (r.kisi||'') +'</td>'+ 
                                        '<td style="padding:4px 6px;border:1px solid #eee;">'+ statusBadge(r.statuscode) +'</td>'+ 
                                        '<td style="padding:4px 6px;border:1px solid #eee;">'+ (r.kullanici||'') +'</td>'+ 
                                        '<td style="padding:4px 6px;border:1px solid #eee;max-width:320px;overflow:hidden;text-overflow:ellipsis;">'+ (r.cevapKisa||'') +'</td>'+ 
                                    '</tr>';
                                }).join('');
                                html += '</tbody></table>';
                                box.innerHTML = html;
                                __dailyLogLoaded = true;
                            }catch(e){ box.innerHTML='Hata: '+ e.message; }
                        }
                        function toggleDailyLogDetails(){
                            const box = document.getElementById('dailyLogDetails');
                            if(!box) return;
                            const visible = box.style.display !== 'none';
                            box.style.display = visible ? 'none' : 'block';
                            if(!visible && !__dailyLogLoaded){ loadDailyLogDetails(); }
                        }
                        window.toggleDailyLogDetails = toggleDailyLogDetails;
                        window.loadDailyLogDetails = loadDailyLogDetails;
                        
                        // Preview monthly data
                        async function previewMonthlyData() {
                            const yil = document.getElementById('monthlyYil').value;
                            const ay = document.getElementById('monthlyAy').value;
                            const previewDiv = document.getElementById('monthlyPreview');
                            
                            try {
                                showGlobalSpinner();
                                
                                const response = await fetch('/monthly-preview', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ yil: parseInt(yil), ay: parseInt(ay) })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    const veri = data.veri;
                                    const gonderim = data.gonderimDurumu;
                                    
                                    const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                                    
                                    let previewHTML = '<h4 style="color: #17a2b8; margin-bottom: 15px;">📊 ' + ayAdlari[ay] + ' ' + yil + ' - Aylık Veri Önizlemesi</h4>';
                                    
                                    if (gonderim.gonderildi) {
                                        previewHTML += '<div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 10px; border-radius: 5px; margin-bottom: 15px;">';
                                        previewHTML += '⚠️ Bu dönem için zaten aylık gönderim yapılmış!<br>';
                                        previewHTML += '<small>Gönderen: ' + gonderim.detay.kullaniciTipi + ' - ' + gonderim.detay.kullaniciAdi + '</small>';
                                        previewHTML += '</div>';
                                    }
                                    
                                    previewHTML += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px;">';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #28a745; font-size: 20px; font-weight: bold;">' + veri.toplamCiro.toLocaleString('tr-TR') + '₺</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Toplam Ciro</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #007bff; font-size: 20px; font-weight: bold;">' + veri.toplamKisi.toLocaleString('tr-TR') + '</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Toplam Kişi</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #ffc107; font-size: 20px; font-weight: bold;">' + veri.gunSayisi + '</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Gün Sayısı</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #dc3545; font-size: 20px; font-weight: bold;">' + veri.manuelDuzeltmeSayisi + '</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Manuel Düzeltme</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '</div>';
                                    
                                    previewHTML += '<div style="font-size: 14px; color: #495057; line-height: 1.6;">';
                                    previewHTML += '<p><strong>Günlük Ortalama Ciro:</strong> ' + (veri.toplamCiro / veri.gunSayisi).toFixed(2) + '₺</p>';
                                    previewHTML += '<p><strong>Günlük Ortalama Kişi:</strong> ' + Math.round(veri.toplamKisi / veri.gunSayisi) + '</p>';
                                    previewHTML += '</div>';
                                    
                                    previewDiv.innerHTML = previewHTML;
                                    previewDiv.style.display = 'block';
                                } else {
                                    alert('Veri önizleme hatası: ' + data.message);
                                }
                            } catch (error) {
                                console.error('Preview error:', error);
                                alert('Önizleme sırasında hata oluştu!');
                            } finally {
                                hideGlobalSpinner();
                            }
                        }
                        
                        // Send monthly data
                        async function sendMonthlyData() {
                            const yil = document.getElementById('monthlyYil').value;
                            const ay = document.getElementById('monthlyAy').value;
                            
                            const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                            
                            if (!confirm(ayAdlari[ay] + ' ' + yil + ' dönemi için aylık raporu göndermek istediğinizden emin misiniz?\\n\\nBu işlem geri alınamaz!')) {
                                return;
                            }
                            
                            try {
                                showGlobalSpinner();
                                
                                const response = await fetch('/monthly-send', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ yil: parseInt(yil), ay: parseInt(ay) })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    alert('✅ Başarılı!\\n\\n' + data.message + '\\n\\nToplam Ciro: ' + data.veri.toplamCiro.toLocaleString('tr-TR') + '₺\\nToplam Kişi: ' + data.veri.toplamKisi.toLocaleString('tr-TR'));
                                    
                                    // Reset preview and reload history
                                    document.getElementById('monthlyPreview').style.display = 'none';
                                    loadMonthlyHistory();
                                } else {
                                    alert('❌ Hata: ' + data.message);
                                }
                            } catch (error) {
                                console.error('Send error:', error);
                                alert('Gönderim sırasında hata oluştu!');
                            } finally {
                                hideGlobalSpinner();
                            }
                        }
                        
                        // Load monthly history
                        async function loadMonthlyHistory() {
                            try {
                                const response = await fetch('/monthly-history');
                                const data = await response.json();
                                
                                if (data.success) {
                                    const historyDiv = document.getElementById('monthlyHistory');
                                    const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                                    
                                    if (data.gecmis.length === 0) {
                                        historyDiv.innerHTML = '<p style="color: #6c757d; text-align: center; padding: 20px;">Henüz aylık gönderim yapılmamış.</p>';
                                        return;
                                    }
                                    
                                    let historyHTML = '';
                                    data.gecmis.forEach(item => {
                                        const durum = item.durum === 'BASARILI' ? 
                                            '<span style="color: #28a745; font-weight: bold;">✅ Başarılı</span>' :
                                            '<span style="color: #dc3545; font-weight: bold;">❌ Hata</span>';
                                            
                                        const tip = item.kullaniciTipi === 'SCHEDULER' ? 
                                            '<span style="color: #17a2b8;">🤖 Otomatik</span>' :
                                            '<span style="color: #fd7e14;">👤 Manuel</span>';
                                            
                                        let borderColor = item.durum === 'BASARILI' ? '#28a745' : '#dc3545';
                                        historyHTML += '<div style="background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; border-left: 4px solid ' + borderColor + ';">';
                                        historyHTML += '<div style="display: flex; justify-content: between; align-items: center; margin-bottom: 10px;">';
                                        historyHTML += '<div style="font-weight: 600; color: #2c3e50;">' + ayAdlari[item.ay] + ' ' + item.yil + '</div>';
                                        historyHTML += '<div style="text-align: right;">';
                                        historyHTML += '<div>' + durum + '</div>';
                                        historyHTML += '<div style="font-size: 12px; color: #6c757d;">' + tip + '</div>';
                                        historyHTML += '</div>';
                                        historyHTML += '</div>';
                                        historyHTML += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 14px;">';
                                        historyHTML += '<div><strong>Ciro:</strong> ' + parseFloat(item.toplamCiro).toLocaleString('tr-TR') + '₺</div>';
                                        historyHTML += '<div><strong>Kişi:</strong> ' + item.toplamKisi.toLocaleString('tr-TR') + '</div>';
                                        historyHTML += '<div><strong>Tarih:</strong> ' + new Date(item.gonderimTarihi).toLocaleDateString('tr-TR') + '</div>';
                                        historyHTML += '</div>';
                                        historyHTML += '<div style="font-size: 12px; color: #6c757d; margin-top: 5px;">';
                                        historyHTML += 'Gönderen: ' + item.kullaniciAdi;
                                        historyHTML += '</div>';
                                        historyHTML += '</div>';
                                    });
                                    
                                    historyDiv.innerHTML = historyHTML;
                                }
                            } catch (error) {
                                console.error('History load error:', error);
                            }
                        }

                        // Deep preview (geçmiş ay günlük + aylık özet) sadece yetkili kullanıcı
                        async function runLastMonthDeepPreview(btnEl) {
                            const btn = btnEl || (typeof event !== 'undefined' ? event.target : null);
                            const container = document.getElementById('deepPreviewResult');
                            if (!container) return;
                            try {
                                btn.disabled = true; const original = btn.innerHTML; btn.innerHTML = 'Çalışıyor...';
                                container.style.display = 'block';
                                container.innerHTML = '<em>Yükleniyor...</em>';
                                const resp = await fetch('/monthly-last-month-deep-preview');
                                const data = await resp.json();
                                if (!data.success) { container.innerHTML = 'Hata: '+ data.message; return; }
                                const v = data.veri; const dwh = data.dwh || {}; const ayAd=['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
                                let html = '';
                                html += '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">📅 ' + ayAd[v.ay] + ' ' + v.yil + ' Derin Önizleme</div>';
                                html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">' +
                                    '<div style="background:#fff;padding:10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Toplam Ciro</div><div style="font-weight:600;color:#1e8e3e;">' + v.toplamCiro.toLocaleString('tr-TR') + '₺</div></div>' +
                                    '<div style="background:#fff;padding:10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Toplam Kişi</div><div style="font-weight:600;color:#1d5fbf;">' + v.toplamKisi.toLocaleString('tr-TR') + '</div></div>' +
                                    '<div style="background:#fff;padding:10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Gönderilen Gün</div><div style="font-weight:600;">' + v.gunSayisi + '</div></div>' +
                                    '<div style="background:#fff;padding:10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Beklenen Gün</div><div style="font-weight:600;">' + v.beklenenGunSayisi + '</div></div>' +
                                    '<div style="background:#fff;padding:10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="font-size:11px;color:#667;">Eksik Gün</div><div style="font-weight:600;color:' + (v.eksikGunler.length ? '#d35400' : '#16a34a') + ';">' + v.eksikGunler.length + '</div></div>' +
                                '</div>';
                                if (v.eksikGunler.length) {
                                    html += '<div style="background:#fff3cd;border:1px solid #ffe69c;padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px;">Eksik Günler: ' + v.eksikGunler.join(', ') + '<br><button onclick="triggerAutoFillLastMonth()" style="margin-top:6px;padding:6px 10px;background:#ff9800;border:none;border-radius:5px;cursor:pointer;color:#222;font-weight:600;">⚙️ Auto-Fill Çalıştır</button></div>';
                                }

                                // DWH karşılaştırma alanı
                                if (dwh && dwh.dwhToplamCiro !== null && dwh.dwhToplamCiro !== undefined) {
                                    html += '<details open style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;font-weight:600;">DWH Karşılaştırma</summary>';
                                    if (dwh.dwhError) {
                                        html += '<div style="margin-top:6px;color:#b71c1c;font-size:12px;">DWH Hatası: ' + dwh.dwhError + '</div>';
                                    } else {
                                        const farkClr = Math.abs(parseFloat(dwh.farkYuzdeCiro||0)) > 0.5 ? '#d35400' : '#2e7d32';
                                        html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:8px;font-size:12px;">' +
                                            '<div style="background:#fff;padding:8px 10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="color:#667;font-size:11px;">DWH Toplam Ciro</div><div style="font-weight:600;">' + Number(dwh.dwhToplamCiro).toLocaleString('tr-TR') + '₺</div></div>' +
                                            '<div style="background:#fff;padding:8px 10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="color:#667;font-size:11px;">LOG Toplam Ciro</div><div style="font-weight:600;">' + v.toplamCiro.toLocaleString('tr-TR') + '₺</div></div>' +
                                            '<div style="background:#fff;padding:8px 10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="color:#667;font-size:11px;">Fark (₺)</div><div style="font-weight:600;color:'+farkClr+';">' + (dwh.farkCiro || '0.00') + '</div></div>' +
                                            '<div style="background:#fff;padding:8px 10px;border:1px solid #e3e7ed;border-radius:6px;"><div style="color:#667;font-size:11px;">Fark (%)</div><div style="font-weight:600;color:'+farkClr+';">' + (dwh.farkYuzdeCiro || '0.00') + '%</div></div>' +
                                        '</div>';
                                    }
                                    html += '</details>';
                                }
                                html += '<details open style="margin-top:6px;"><summary style="cursor:pointer;font-size:12px;font-weight:600;margin-bottom:6px;">Günlük Detaylar (' + v.detaylar.length + ')</summary>';
                                html += '<table style="width:100%;border-collapse:collapse;font-size:11.5px;"><thead><tr style="background:#f2f4f7;"><th style="text-align:left;padding:4px 6px;border:1px solid #dfe3e8;">Tarih</th><th style="text-align:right;padding:4px 6px;border:1px solid #dfe3e8;">Ciro</th><th style="text-align:right;padding:4px 6px;border:1px solid #dfe3e8;">Kişi</th></tr></thead><tbody>' +
                                    v.detaylar.map(function(d){ return '<tr><td style="padding:4px 6px;border:1px solid #eee;">'+ d.tarih +'</td><td style="padding:4px 6px;border:1px solid #eee;text-align:right;color:#1e8e3e;">'+ d.ciro.toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2}) +'</td><td style="padding:4px 6px;border:1px solid #eee;text-align:right;color:#1d5fbf;">'+ d.kisi.toLocaleString('tr-TR') +'</td></tr>'; }).join('') +
                                    '</tbody></table></details>';
                                container.innerHTML = html;
                            } catch (e) {
                                container.innerHTML = 'Hata: '+e.message;
                            } finally {
                                btn.disabled = false; btn.innerHTML = '🧪 Geçmiş Ay Derin Önizleme';
                            }
                        }

                        async function triggerAutoFillLastMonth() {
                            const btn = event.target;
                            btn.disabled = true; const original = btn.innerHTML; btn.innerHTML = 'Çalışıyor...';
                            try {
                                const resp = await fetch('/monthly-last-month-autofill-run', { method:'POST' });
                                const data = await resp.json();
                                if (!data.success) { alert('Auto-Fill hata: '+ data.message); return; }
                                alert('Auto-Fill tamamlandı.\nGönderilen: '+ data.sonuc.sentDays.length +'\nBulunamadı: '+ data.sonuc.notFoundDays.length +'\nHatalı: '+ data.sonuc.failedDays.length);
                                // Yeniden derin önizleme yükle
                                runLastMonthDeepPreview();
                            } catch(e) {
                                alert('Auto-Fill tetikleme hatası: '+ e.message);
                            } finally {
                                btn.disabled = false; btn.innerHTML = original;
                            }
                        }
                        
                        // Explicit global exposure for inline buttons
                        window.runLastMonthDeepPreview = runLastMonthDeepPreview; // overwrite early stub
                        window.triggerAutoFillLastMonth = triggerAutoFillLastMonth;

                        // Form gönderimlerinde loading spinner göster
                        document.addEventListener('DOMContentLoaded', function() {
                            const forms = document.querySelectorAll('form');
                            const globalSpinner = document.getElementById('globalSpinner');
                            
                            forms.forEach(function(form) {
                                form.addEventListener('submit', function(e) {
                                    // Sadece send formlarını işle
                                    if (!form.querySelector('input[name="tarih"]')) {
                                        return;
                                    }
                                    
                                    const formData = new FormData(this);
                                    const ciro = formData.get('ciro');
                                    const kisi = formData.get('kisi');
                                    const tarih = formData.get('tarih');
                                    
                                    // Validation
                                    if (!ciro || !kisi || !tarih) {
                                        e.preventDefault();
                                        alert('Lütfen tüm alanları doldurun!');
                                        return;
                                    }
                                    
                                    if (parseFloat(ciro) <= 0) {
                                        e.preventDefault();
                                        alert('Ciro değeri 0dan büyük olmalıdır!');
                                        return;
                                    }
                                    
                                    if (parseInt(kisi) <= 0) {
                                        e.preventDefault();
                                        alert('Kişi sayısı 0dan büyük olmalıdır!');
                                        return;
                                    }
                                    
                                    // Loading spinner göster
                                    const button = this.querySelector('button[type="submit"]');
                                    const originalButtonHTML = button.innerHTML; // Save the original button content
                                    const localSpinner = this.querySelector('div.spinner'); // Get the spinner div next to the button

                                    // Disable button and show loading state
                                    button.disabled = true;
                                    button.innerHTML = 'Gönderiliyor...'; // Set button text
                                    button.classList.add('btn-loading'); // Add class for styling (e.g., opacity, pointer-events)
                                    
                                    if (localSpinner) {
                                        localSpinner.style.display = 'inline-block'; // Show the local spinner
                                    }
                                    
                                    e.preventDefault(); // Prevent default form submission
                                    const sendFormData = new FormData(this); // Get form data
                                    
                                    fetch('/send', {
                                        method: 'POST',
                                        body: sendFormData
                                    })
                                    .then(response => {
                                        if (response.ok) {
                                            window.location.reload(); // Reload page on success
                                        } else {
                                            return response.text().then(text => {
                                                throw new Error('te');
                                            });
                                        }
                                    })
                                    .catch(error => {
                                        console.error('Error:', error);
                                        alert('Gönderim sırasında hata oluştu: ' + error.message);
                                        // No need to restore button here if finally block is comprehensive
                                    })
                                    .finally(() => {
                                        // This block executes regardless of success or failure,
                                        // but if page reloads, this restoration might not be visible.
                                        // It's good practice for handling errors where page doesn't reload.
                                        if (localSpinner) {
                                            localSpinner.style.display = 'none'; // Hide the local spinner
                                        }
                                        button.disabled = false;
                                        button.innerHTML = originalButtonHTML; // Restore original button content
                                        button.classList.remove('btn-loading');
                                    });
                                });
                            });
                            
                            // Sayfa yüklendiğinde spinner'ın kesinlikle gizli olduğundan emin ol
                            if (globalSpinner) {
                                globalSpinner.style.display = 'none';
                            }
                            
                            // Load monthly history on page load
                            loadMonthlyHistory();
                        });
                        
                        // Preview monthly data
                        async function previewMonthlyData() {
                            const yil = document.getElementById('monthlyYil').value;
                            const ay = document.getElementById('monthlyAy').value;
                            const previewDiv = document.getElementById('monthlyPreview');
                            
                            try {
                                showGlobalSpinner();
                                
                                const response = await fetch('/monthly-preview', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ yil: parseInt(yil), ay: parseInt(ay) })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    const veri = data.veri;
                                    const gonderim = data.gonderimDurumu;
                                    
                                    const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                                    
                                    let previewHTML = '<h4 style="color: #17a2b8; margin-bottom: 15px;">📊 ' + ayAdlari[ay] + ' ' + yil + ' - Aylık Veri Önizlemesi</h4>';
                                    
                                    if (gonderim.gonderildi) {
                                        previewHTML += '<div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 10px; border-radius: 5px; margin-bottom: 15px;">';
                                        previewHTML += '⚠️ Bu dönem için zaten aylık gönderim yapılmış!<br>';
                                        previewHTML += '<small>Gönderen: ' + gonderim.detay.kullaniciTipi + ' - ' + gonderim.detay.kullaniciAdi + '</small>';
                                        previewHTML += '</div>';
                                    }
                                    
                                    previewHTML += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px;">';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #28a745; font-size: 20px; font-weight: bold;">' + veri.toplamCiro.toLocaleString('tr-TR') + '₺</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Toplam Ciro</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #007bff; font-size: 20px; font-weight: bold;">' + veri.toplamKisi.toLocaleString('tr-TR') + '</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Toplam Kişi</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #ffc107; font-size: 20px; font-weight: bold;">' + veri.gunSayisi + '</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Gün Sayısı</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '<div style="background: white; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">';
                                    previewHTML += '<div style="color: #dc3545; font-size: 20px; font-weight: bold;">' + veri.manuelDuzeltmeSayisi + '</div>';
                                    previewHTML += '<div style="color: #6c757d; font-size: 12px;">Manuel Düzeltme</div>';
                                    previewHTML += '</div>';
                                    previewHTML += '</div>';
                                    
                                    previewHTML += '<div style="font-size: 14px; color: #495057; line-height: 1.6;">';
                                    previewHTML += '<p><strong>Günlük Ortalama Ciro:</strong> ' + (veri.toplamCiro / veri.gunSayisi).toFixed(2) + '₺</p>';
                                    previewHTML += '<p><strong>Günlük Ortalama Kişi:</strong> ' + Math.round(veri.toplamKisi / veri.gunSayisi) + '</p>';
                                    previewHTML += '</div>';
                                    
                                    previewDiv.innerHTML = previewHTML;
                                    
                                    previewDiv.style.display = 'block';
                                } else {
                                    alert('Veri önizleme hatası: ' + data.message);
                                }
                            } catch (error) {
                                console.error('Preview error:', error);
                                alert('Önizleme sırasında hata oluştu!');
                            } finally {
                                hideGlobalSpinner();
                            }
                        }
                        
                        // Send monthly data
                        async function sendMonthlyData() {
                            const yil = document.getElementById('monthlyYil').value;
                            const ay = document.getElementById('monthlyAy').value;
                            
                            const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                            
                            if (!confirm(ayAdlari[ay] + ' ' + yil + ' dönemi için aylık raporu göndermek istediğinizden emin misiniz?\\n\\nBu işlem geri alınamaz!')) {
                                return;
                            }
                            
                            try {
                                showGlobalSpinner();
                                
                                const response = await fetch('/monthly-send', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ yil: parseInt(yil), ay: parseInt(ay) })
                                });
                                
                                const data = await response.json();
                                
                                if (data.success) {
                                    alert('✅ Başarılı!\\n\\n' + data.message + '\\n\\nToplam Ciro: ' + data.veri.toplamCiro.toLocaleString('tr-TR') + '₺\\nToplam Kişi: ' + data.veri.toplamKisi.toLocaleString('tr-TR'));
                                    
                                    // Reset preview and reload history
                                    document.getElementById('monthlyPreview').style.display = 'none';
                                    loadMonthlyHistory();
                                } else {
                                    alert('❌ Hata: ' + data.message);
                                }
                            } catch (error) {
                                console.error('Send error:', error);
                                alert('Gönderim sırasında hata oluştu!');
                            } finally {
                                hideGlobalSpinner();
                            }
                        }
                        
                        // Load monthly history
                        async function loadMonthlyHistory() {
                            try {
                                const response = await fetch('/monthly-history');
                                const data = await response.json();
                                
                                if (data.success) {
                                    const historyDiv = document.getElementById('monthlyHistory');
                                    const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                                    
                                    if (data.gecmis.length === 0) {
                                        historyDiv.innerHTML = '<p style="color: #6c757d; text-align: center; padding: 20px;">Henüz aylık gönderim yapılmamış.</p>';
                                        return;
                                    }
                                    
                                    let historyHTML = '';
                                    data.gecmis.forEach(item => {
                                        const durum = item.durum === 'BASARILI' ? 
                                            '<span style="color: #28a745; font-weight: bold;">✅ Başarılı</span>' :
                                            '<span style="color: #dc3545; font-weight: bold;">❌ Hata</span>';
                                            
                                        const tip = item.kullaniciTipi === 'SCHEDULER' ? 
                                            '<span style="color: #17a2b8;">🤖 Otomatik</span>' :
                                            '<span style="color: #fd7e14;">👤 Manuel</span>';
                                            
                                        let borderColor = item.durum === 'BASARILI' ? '#28a745' : '#dc3545';
                                        historyHTML += '<div style="background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; border-left: 4px solid ' + borderColor + ';">';
                                        historyHTML += '<div style="display: flex; justify-content: between; align-items: center; margin-bottom: 10px;">';
                                        historyHTML += '<div style="font-weight: 600; color: #2c3e50;">' + ayAdlari[item.ay] + ' ' + item.yil + '</div>';
                                        historyHTML += '<div style="text-align: right;">';
                                        historyHTML += '<div>' + durum + '</div>';
                                        historyHTML += '<div style="font-size: 12px; color: #6c757d;">' + tip + '</div>';
                                        historyHTML += '</div>';
                                        historyHTML += '</div>';
                                        historyHTML += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 14px;">';
                                        historyHTML += '<div><strong>Ciro:</strong> ' + parseFloat(item.toplamCiro).toLocaleString('tr-TR') + '₺</div>';
                                        historyHTML += '<div><strong>Kişi:</strong> ' + item.toplamKisi.toLocaleString('tr-TR') + '</div>';
                                        historyHTML += '<div><strong>Tarih:</strong> ' + new Date(item.gonderimTarihi).toLocaleDateString('tr-TR') + '</div>';
                                        historyHTML += '</div>';
                                        historyHTML += '<div style="font-size: 12px; color: #6c757d; margin-top: 5px;">';
                                        historyHTML += 'Gönderen: ' + item.kullaniciAdi;
                                        historyHTML += '</div>';
                                        historyHTML += '</div>';
                                    });
                                    
                                    historyDiv.innerHTML = historyHTML;
                                }
                            } catch (error) {
                                console.error('History load error:', error);
                            }
                        }
                    </script>
                </body>
                </html>
            `);
        } catch (err) {
            res.status(500).send('Database error: ' + err.message);
        } finally {
            if (dwhPool) {
                await dwhPool.close();
            }
        }
    }
});

// Login endpoint
app.post('/login', (req, res) => {
    const { upp } = req.body;
    if (upp === "z9x1v7b2") {
        req.session.login = "z9x1v7b2";
    }
    res.redirect('/');
});

// AD Login endpoint
app.post('/ad-login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Giriş formundan gelen kullanıcı bilgilerini AD authentication'a gönder
        const isAuthenticated = await authenticateAD(username, password);

        if (isAuthenticated) {
            req.session.adUser = username;
            console.log(`AD Login successful for user: ${username}`);
            res.redirect('/');
        } else {
            console.log(`AD Login failed for user: ${username}`);
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Login Failed</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { 
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                        }
                        .error-container {
                            background: white;
                            padding: 40px;
                            border-radius: 15px;
                            text-align: center;
                            box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                            max-width: 400px;
                        }
                        .error-icon {
                            font-size: 48px;
                            margin-bottom: 20px;
                        }
                        h2 {
                            color: #dc3545;
                            margin-bottom: 15px;
                        }
                        p {
                            color: #6c757d;
                            margin-bottom: 25px;
                        }
                        .btn {
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            text-decoration: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                            font-weight: 600;
                            transition: all 0.3s;
                        }
                        .btn:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
                        }
                    </style>
                </head>
                <body>
                    <div class="error-container">
                        <div class="error-icon">🚫</div>
                        <h2>Giriş Başarısız</h2>
                        <p>Active Directory kullanıcı adı veya şifre hatalı.<br>Lütfen tekrar deneyin.</p>
                        <a href="/" class="btn">Geri Dön</a>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        console.error('AD Login error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Server Error</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { 
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .error-container {
                        background: white;
                        padding: 40px;
                        border-radius: 15px;
                        text-align: center;
                        box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                        max-width: 400px;
                    }
                    .error-icon {
                        font-size: 48px;
                        margin-bottom: 20px;
                    }
                    h2 {
                        color: #dc3545;
                        margin-bottom: 15px;
                    }
                    p {
                        color: #6c757d;
                        margin-bottom: 25px;
                    }
                    .btn {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        text-decoration: none;
                        padding: 12px 24px;
                        border-radius: 8px;
                        font-weight: 600;
                        transition: all 0.3s;
                    }
                    .btn:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
                    }
                    </style>
            </head>
            <body>
                <div class="error-container">
                    <div class="error-icon">⚠️</div>
                    <h2>Sunucu Hatası</h2>
                    <p>Active Directory bağlantısında bir sorun oluştu.<br>Lütfen sistem yöneticisi ile iletişime geçin.</p>
                    <a href="/" class="btn">Geri Dön</a>
                </div>
            </body>
            </html>
        `);
    }
});

// Logout endpoint
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Send data endpoint
app.post('/send', requireLogin, async (req, res) => {
    const { ciro, kisi, tarih } = req.body;
    let restoPool;

    let gonderenKullanici = 'Bilinmeyen Kullanıcı';
    let kullaniciTipi = 'unknown';

    if (req.session.adUser) {
        gonderenKullanici = req.session.adUser;
        kullaniciTipi = 'AD';
        console.log(`🔐 [AD GİRİŞ] Kullanıcı: ${gonderenKullanici} - Gönderim başlatıldı`);
    } else if (req.session.login === "z9x1v7b2") {
        gonderenKullanici = 'Sistem Kullanıcısı (Basit Login)';
        kullaniciTipi = 'sistem';
        console.log(`🔑 [SİSTEM GİRİŞ] Basit login ile gönderim başlatıldı`);
    }

    const fullUserInfo = `${kullaniciTipi.toUpperCase()}: ${gonderenKullanici}`;
    console.log(`📊 [GÖNDER] Kullanıcı: ${fullUserInfo}, Tarih: ${tarih}, Ciro: ${ciro}₺, Kişi: ${kisi}`);

    try {
        // Normalize numeric formats (string with dot decimal, consistent with monthly)
        const netCiro = (parseFloat(ciro) || 0).toFixed(2); // ensures 2 decimals
        const txCount = (parseInt(kisi, 10) || 0).toString();

        // Tarih formatı API için ISO'ya dönüştür (manuel giriş dd.MM.yyyy geliyor)
        function toIsoDate(src){
            if(!src) return src;
            // dd.MM.yyyy
            const m = src.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
            if(m){
                const dd = m[1].padStart(2,'0');
                const mm = m[2].padStart(2,'0');
                const yyyy = m[3];
                return `${yyyy}-${mm}-${dd}`;
            }
            // already yyyy-MM-dd
            if(/^\d{4}-\d{2}-\d{2}$/.test(src)) return src;
            // fallback: try Date parse
            const d = new Date(src);
            if(!isNaN(d.getTime())){
                const dd = String(d.getDate()).padStart(2,'0');
                const mm = String(d.getMonth()+1).padStart(2,'0');
                const yyyy = d.getFullYear();
                return `${yyyy}-${mm}-${dd}`;
            }
            return src; // as-is
        }

        const isoDate = toIsoDate(tarih);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
            console.warn('[MANUAL_SEND] Tarih ISO formatına dönüştürülemedi, gönderilen:', isoDate, 'orijinal:', tarih);
        }

        const payload = [{
            SalesToDATE: isoDate,
            SalesFromDATE: isoDate,
            NetSalesAmount: netCiro,       // string form
            NoofTransactions: txCount,     // string form
            SalesFrequency: 'Daily',
            PropertyCode: 'ESM',
            LeaseCode: 't0000967',
            SaleType: 'food'
        }];

        const response = await axios.post(API_URL, payload, { headers: API_HEADERS });

        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();

        await restoPool.request()
            .input('tarih', sql.DateTime, new Date())
            .input('ip', sql.VarChar, req.ip)
            .input('kullanici', sql.VarChar, fullUserInfo)
            .input('tablo', sql.VarChar, 'ciro')
            .input('veri', sql.Text, JSON.stringify(payload))
            .input('veri1', sql.VarChar, ciro)
            .input('veri2', sql.VarChar, kisi)
            .input('veri3', sql.VarChar, tarih)
            .input('cevap', sql.Text, JSON.stringify(response.data))
            .input('statuscode', sql.Int, response.status)
            .query(`INSERT INTO basar.personelLog 
                    (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode) 
                    VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)`);

        await sendEmail(ciro, kisi, tarih, fullUserInfo);

        console.log(`✅ [BAŞARILI] Veri gönderildi! API Status: ${response.status}, Kullanıcı: ${fullUserInfo}`);

        res.redirect('/');
    } catch (err) {
        let apiStatus = err.response?.status;
        let apiBody = err.response?.data;
        if(apiStatus){
            console.error(`❌ [HATA] Gönderim başarısız! Status=${apiStatus} Kullanıcı=${fullUserInfo}`);
            if(apiBody) {
                try { console.error('↩️ API BODY:', typeof apiBody === 'string' ? apiBody : JSON.stringify(apiBody)); } catch(_e) {}
            }
        } else {
            console.error(`❌ [HATA] Gönderim başarısız! Kullanıcı: ${fullUserInfo}, Hata: ${err.message}`);
        }

        if (!restoPool) {
            restoPool = new sql.ConnectionPool(restoConfig);
            await restoPool.connect();
        }

        await restoPool.request()
            .input('tarih', sql.DateTime, new Date())
            .input('ip', sql.VarChar, req.ip)
            .input('kullanici', sql.VarChar, fullUserInfo)
            .input('tablo', sql.VarChar, 'ciro_error')
            .input('veri', sql.Text, JSON.stringify({ ciro, kisi, tarih }))
            .input('veri1', sql.VarChar, ciro)
            .input('veri2', sql.VarChar, kisi)
            .input('veri3', sql.VarChar, tarih)
            .input('cevap', sql.Text, apiBody ? (typeof apiBody === 'string' ? apiBody : JSON.stringify(apiBody)) : err.message)
            .input('statuscode', sql.Int, apiStatus || 500)
            .query(`INSERT INTO basar.personelLog 
                    (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode) 
                    VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)`);

        try {
            await sendErrorEmail({
                ciro,
                kisi,
                tarih,
                kullanici: fullUserInfo,
                source: 'MANUAL_SEND',
                errorMessage: err.message,
                errorStack: err.stack || '',
                severity: 'ERROR',
                context: { 
                    route: '/send', 
                    originalPayload: { ciro, kisi, tarih },
                    apiPayload: { SalesFromDATE: isoDate, SalesToDATE: isoDate, NetSalesAmount: (parseFloat(ciro)||0).toFixed(2), NoofTransactions: (parseInt(kisi,10)||0).toString() },
                    apiStatus, 
                    apiBody: apiBody && (typeof apiBody === 'string' ? apiBody : JSON.stringify(apiBody)).slice(0,4000)
                }
            });
        } catch (mailErr) {
            console.error('Hata emaili gönderilemedi (MANUAL_SEND):', mailErr.message);
        }
        res.status(500).send('Send error: ' + err.message);
    } finally {
        if (restoPool) {
            await restoPool.close();
        }
    }
});

// Günlük detay log endpointi (son 60 gün)
app.get('/daily-log-details', requireLogin, async (req, res) => {
    let pool;
    try {
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();
        const result = await pool.request()
            .query(`SELECT TOP 500
                id = ROW_NUMBER() OVER(ORDER BY tarih DESC),
                tarih as logZamani,
                veri3 as gunTarihi,
                veri1 as ciro,
                veri2 as kisi,
                statuscode,
                kullanici,
                SUBSTRING(CAST(cevap AS NVARCHAR(MAX)),1,4000) AS cevapKisa
            FROM basar.personelLog
            WHERE tablo = 'ciro'
              AND TRY_CONVERT(date, veri3, 104) >= DATEADD(day,-60, CAST(GETDATE() as date))
            ORDER BY tarih DESC`);
        res.json({ success:true, rows: result.recordset });
    } catch(e){
        console.error('daily-log-details hata', e.message);
        res.json({ success:false, message:e.message });
    } finally { if(pool) await pool.close(); }
});

// 🚀 GÜNLÜK SCHEDULER - Her gün 17:00'da "dünkü" günü gönderir
// Tek tarih işlenir, tarih formatı DD.MM.YYYY olarak normalize edildi
schedule.scheduleJob('0 17 * * *', async () => {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); // dün
    const dd = String(target.getDate()).padStart(2, '0');
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const yyyy = target.getFullYear();
    const trDate = `${dd}.${mm}.${yyyy}`; // Log & DB format
    const isoDate = `${yyyy}-${mm}-${dd}`; // API format

    console.log(`🚀 [DAILY] Otomatik günlük görev başladı - Hedef Tarih: ${trDate} (${isoDate})`);

    let dwhPool;
    let restoPool;
    try {
        // 1. Daha önce gönderilmiş mi?
        const durum = await gonderimDurum(trDate);
        if (durum.sent) {
            console.log(`⏭️ [DAILY] ${trDate} zaten gönderilmiş. İşlem atlandı.`);
            return;
        }

        // 2. DWH'den dünkü kayıt (tek)
        dwhPool = new sql.ConnectionPool(dwhConfig);
        await dwhPool.connect();
        const dwhResult = await dwhPool.request()
            .input('tarih', sql.VarChar, trDate)
            .query(`
                SELECT TOP 1 
                    Tarih,
                    CAST(Ciro AS DECIMAL(18,2)) AS Ciro,
                    [Kişi Sayısı] AS Kisi
                FROM [DWH].[dbo].[FactKisiSayisiCiro]
                WHERE [Şube Kodu] = 17672
                  AND Tarih = @tarih
                ORDER BY CONVERT(datetime, Tarih, 104) DESC
            `);

        if (dwhResult.recordset.length === 0) {
            console.warn(`⚠️ [DAILY] DWH'de ${trDate} için veri bulunamadı. Gönderim yapılmadı.`);
            return;
        }

    const row = dwhResult.recordset[0];
    const ciro = parseFloat(row.Ciro).toFixed(2); // keep as string with 2 decimals
    const kisi = parseInt(row.Kisi);

        // 3. API payload
        const payload = [{
            SalesFromDATE: isoDate,
            SalesToDATE: isoDate,
            NetSalesAmount: ciro,                // unified string format
            NoofTransactions: kisi.toString(),   // unified string format
            SalesFrequency: 'Daily',
            PropertyCode: 'ESM',
            LeaseCode: 't0000967',
            SaleType: 'food'
        }];

        console.log(`📤 [DAILY] Gönderiliyor → Tarih: ${isoDate}, Ciro: ${ciro}, Kişi: ${kisi}`);

        // 4. API çağrısı (tek deneme; geliştirme: retry eklenebilir)
        const response = await axios.post(API_URL, payload, { headers: API_HEADERS });
        console.log(`✅ [DAILY] API Status: ${response.status}`);

        // 5. Log kaydı
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        await restoPool.request()
            .input('tarih', sql.DateTime, new Date())
            .input('ip', sql.VarChar, 'SCHEDULER')
            .input('kullanici', sql.VarChar, 'SYSTEM: Daily Scheduler')
            .input('tablo', sql.VarChar, 'ciro')
            .input('veri', sql.Text, JSON.stringify(payload))
            .input('veri1', sql.VarChar, ciro)
            .input('veri2', sql.VarChar, kisi.toString())
            .input('veri3', sql.VarChar, trDate)
            .input('cevap', sql.Text, JSON.stringify(response.data))
            .input('statuscode', sql.Int, response.status)
            .query(`INSERT INTO basar.personelLog
                (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode)
                VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)`);

        // 6. Email (tek sefer – önceki çift çağrı bug düzeltildi)
        await sendEmail(ciro, kisi, trDate, 'SYSTEM: Daily Scheduler');
        console.log(`🎉 [DAILY] Görev tamamlandı - ${trDate}`);

    } catch (err) {
        console.error(`❌ [DAILY] Hata: ${err.message}`);
        try {
            await sendErrorEmail({
                kullanici: 'SYSTEM: Daily Scheduler',
                source: 'DAILY_SCHEDULER',
                errorMessage: err.message,
                errorStack: err.stack || '',
                severity: 'ERROR',
                context: { phase: 'SCHEDULE_DAILY', targetDate: trDate }
            });
        } catch (mailErr) {
            console.error('Hata emaili gönderilemedi (DAILY_SCHEDULER):', mailErr.message);
        }
        try {
            if (!restoPool) {
                restoPool = new sql.ConnectionPool(restoConfig);
                await restoPool.connect();
            }
            await restoPool.request()
                .input('tarih', sql.DateTime, new Date())
                .input('ip', sql.VarChar, 'SCHEDULER')
                .input('kullanici', sql.VarChar, 'SYSTEM: Daily Scheduler')
                .input('tablo', sql.VarChar, 'ciro_error')
                .input('veri', sql.Text, JSON.stringify({ error: err.message }))
                .input('veri1', sql.VarChar, '')
                .input('veri2', sql.VarChar, '')
                .input('veri3', sql.VarChar, '')
                .input('cevap', sql.Text, err.stack || '')
                .input('statuscode', sql.Int, 500)
                .query(`INSERT INTO basar.personelLog
                    (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode)
                    VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)`);
        } catch (logErr) {
            console.error('❌ [DAILY] Hata log kaydedilemedi:', logErr.message);
        }
    } finally {
        if (dwhPool) { try { await dwhPool.close(); } catch(_){} }
        if (restoPool) { try { await restoPool.close(); } catch(_){} }
    }
});

// TEST SERVİSİ - COMMENT'LENDİ (Test tamamlandı)
/*
schedule.scheduleJob('* /2 * * * *', async () => {
    console.log('🧪 [TEST] 2 dakikalık mail test servisi çalışıyor:', new Date().toLocaleString('tr-TR'));
    
    try {
        const testCiro = '1250.50';
        const testKisi = '25';
        const testTarih = new Date().toLocaleDateString('tr-TR');
        const testKullanici = 'TEST KULLANICI - Otomatik Test';
        
        await sendEmail(testCiro, testKisi, testTarih, testKullanici);
        console.log('✅ [TEST] Test maili başarıyla gönderildi');
        
    } catch (error) {
        console.error('❌ [TEST] Test maili gönderim hatası:', error.message);
    }
});
*/

// 📅 AYLIK CİRO RAPORU SCHEDULER - Her ayın 2'sinde saat 18:00'da çalışır (Emaar kilitleme politikası için)
schedule.scheduleJob('0 18 2 * *', async () => {
    console.log('📊 [SCHEDULER] Aylık ciro raporu scheduler başlatıldı:', new Date().toLocaleString('tr-TR'));
    
    try {
        // Geçmiş ayı hesapla
        const simdi = new Date();
        const gecmisAy = new Date(simdi.getFullYear(), simdi.getMonth() - 1, 1);
        const yil = gecmisAy.getFullYear();
        const ay = gecmisAy.getMonth() + 1;
        
        console.log(`📅 İşlem yapılacak dönem: ${ay}/${yil}`);
        
        // 1. Önce gönderim kontrolü yap
        const kontrolSonucu = await monthlyOperations.aylikGonderimKontrol(yil, ay);
        
        if (kontrolSonucu.gonderildi) {
            console.log(`⚠️ [SCHEDULER] ${ay}/${yil} için zaten aylık gönderim yapılmış. Es geçiliyor...`);
            console.log(`📋 Gönderim detayı: ${kontrolSonucu.detay.kullaniciTipi} - ${kontrolSonucu.detay.kullaniciAdi}`);
            return;
        }
        
        // 2. Aylık veriyi hesapla
        console.log(`🔢 [SCHEDULER] ${ay}/${yil} dönemi için veri hesaplanıyor...`);
        // Önce eksik günleri otomatik tamamlamaya çalış
        let eksikSonuc;
        try {
            eksikSonuc = await monthlyOperations.tamamlaEksikGunler(yil, ay);
            console.log('🔄 Eksik gün tamamlama özeti (scheduler):', eksikSonuc);
        } catch (e) {
            console.warn('⚠️ Eksik gün tamamlama hata verdi (scheduler) devam ediliyor:', e.message);
        }
        const aylikVeri = await monthlyOperations.aylikVeriHesapla(yil, ay);

        // Abort conditions: still missing days OR auto-fill failures
        const missingCount = (aylikVeri.eksikGunler || []).length;
        const failedCount = eksikSonuc?.failedDays?.length || 0;
        const notFoundCount = eksikSonuc?.notFoundDays?.length || 0;
        if (missingCount > 0 || failedCount > 0 || notFoundCount > 0) {
            console.error('🛑 [SCHEDULER] Aylık gönderim ABORT - eksik veya başarısız günler var', { missingCount, failedCount, notFoundCount });
            try {
                await sendErrorEmail({
                    kullanici: 'SYSTEM: Monthly Scheduler',
                    source: 'MONTHLY_ABORT',
                    severity: 'CRITICAL',
                    errorMessage: `Aylık gönderim iptal edildi. Missing=${missingCount}, Failed=${failedCount}, NotFound=${notFoundCount}`,
                    context: { yil, ay, eksikGunler: aylikVeri.eksikGunler, autoFill: eksikSonuc }
                });
            } catch(_) {}
            return; // do not proceed to API send
        }
        
        console.log(`📊 [SCHEDULER] Hesaplanan veriler:`);
        console.log(`   💰 Toplam Ciro: ${aylikVeri.toplamCiro.toLocaleString('tr-TR')}₺`);
        console.log(`   👥 Toplam Kişi: ${aylikVeri.toplamKisi.toLocaleString('tr-TR')}`);
        console.log(`   📅 Gün Sayısı: ${aylikVeri.gunSayisi}`);
        console.log(`   ✏️ Manuel Düzeltme: ${aylikVeri.manuelDuzeltmeSayisi} gün`);
        
        // 3. Monthly Sales API'ye gönder
        const gonderimSonucu = await monthlyOperations.monthlyApiGonder(
            yil, 
            ay, 
            aylikVeri.toplamCiro, 
            aylikVeri.toplamKisi, 
            'SCHEDULER', 
            'SYSTEM: Otomatik Aylık Scheduler',
            aylikVeri.gunSayisi,
            aylikVeri.detaylar
        );
        
        console.log(`✅ [SCHEDULER] Aylık rapor başarıyla gönderildi!`);
        console.log(`📈 API Status: ${gonderimSonucu.status}, Dönem: ${ay}/${yil}`);
        
    } catch (error) {
        console.error('❌ [SCHEDULER] Aylık rapor scheduler hatası:', error.message);
        console.error('📍 Hata detayı:', error);
    }
});

// 📊 AYLIK RAPOR ROUTE'LARI

// Aylık rapor manuel gönderim
app.post('/monthly-send', async (req, res) => {
    if (!req.session.login && !req.session.adUser) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const { yil, ay } = req.body;
        const kullaniciAdi = req.session.adUser || req.session.username || 'MANUAL USER';
        
        if (!yil || !ay) {
            return res.status(400).json({ 
                success: false, 
                message: 'Yıl ve ay bilgisi gerekli' 
            });
        }

        console.log(`📤 [MANUAL] Aylık rapor manuel gönderim: ${ay}/${yil} - ${kullaniciAdi}`);

        // 1. Gönderim kontrolü
        const kontrolSonucu = await monthlyOperations.aylikGonderimKontrol(parseInt(yil), parseInt(ay));
        
        if (kontrolSonucu.gonderildi) {
            return res.status(409).json({
                success: false,
                message: `${ay}/${yil} için zaten aylık gönderim yapılmış`,
                detay: kontrolSonucu.detay
            });
        }

        // 2. Veri hesapla
        let eksikSonuc;
        try {
            eksikSonuc = await monthlyOperations.tamamlaEksikGunler(parseInt(yil), parseInt(ay));
            console.log('🔄 Eksik gün tamamlama özeti (manuel):', eksikSonuc);
        } catch (e) {
            console.warn('⚠️ Eksik gün tamamlama hata verdi (manuel) devam ediliyor:', e.message);
        }
        const aylikVeri = await monthlyOperations.aylikVeriHesapla(parseInt(yil), parseInt(ay));

        const missingCount = (aylikVeri.eksikGunler || []).length;
        const failedCount = eksikSonuc?.failedDays?.length || 0;
        const notFoundCount = eksikSonuc?.notFoundDays?.length || 0;
        if (missingCount > 0 || failedCount > 0 || notFoundCount > 0) {
            await sendErrorEmail({
                kullanici: kullaniciAdi,
                source: 'MONTHLY_ABORT_MANUAL',
                severity: 'CRITICAL',
                errorMessage: `Aylık gönderim iptal edildi. Missing=${missingCount}, Failed=${failedCount}, NotFound=${notFoundCount}`,
                context: { yil, ay, eksikGunler: aylikVeri.eksikGunler, autoFill: eksikSonuc }
            });
            return res.status(409).json({
                success: false,
                message: 'Aylık gönderim iptal edildi: eksik veya başarısız günler mevcut',
                stats: { missingCount, failedCount, notFoundCount },
                eksikGunler: aylikVeri.eksikGunler,
                autoFill: eksikSonuc
            });
        }

        // 3. API'ye gönder
        const gonderimSonucu = await monthlyOperations.monthlyApiGonder(
            parseInt(yil),
            parseInt(ay),
            aylikVeri.toplamCiro,
            aylikVeri.toplamKisi,
            'MANUAL',
            kullaniciAdi,
            aylikVeri.gunSayisi,
            aylikVeri.detaylar
        );

        res.json({
            success: true,
            message: `${ay}/${yil} aylık raporu başarıyla gönderildi`,
            veri: aylikVeri,
            apiStatus: gonderimSonucu.status
        });

    } catch (error) {
        console.error('❌ Aylık manuel gönderim hatası:', error);
        res.status(500).json({
            success: false,
            message: 'Aylık gönderim sırasında hata oluştu',
            error: error.message
        });
    }
});

// Aylık veri önizleme
app.post('/monthly-preview', async (req, res) => {
    if (!req.session.login && !req.session.adUser) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const { yil, ay } = req.body;
        
        if (!yil || !ay) {
            return res.status(400).json({ 
                success: false, 
                message: 'Yıl ve ay bilgisi gerekli' 
            });
        }

        // Gönderim kontrolü
        const kontrolSonucu = await monthlyOperations.aylikGonderimKontrol(parseInt(yil), parseInt(ay));

        // Veri hesapla
        const aylikVeri = await monthlyOperations.aylikVeriHesapla(parseInt(yil), parseInt(ay));

        res.json({
            success: true,
            veri: aylikVeri,
            gonderimDurumu: kontrolSonucu
        });

    } catch (error) {
        console.error('❌ Aylık veri önizleme hatası:', error);
        res.status(500).json({
            success: false,
            message: 'Veri önizleme sırasında hata oluştu',
            error: error.message
        });
    }
});

// Derin önizleme (geçmiş ay) - sadece atakan.kaplayan erişimi
app.get('/monthly-last-month-deep-preview', async (req, res) => {
    try {
        if (!req.session.adUser || !req.session.adUser.toLowerCase().startsWith('atakan.kaplayan')) {
            return res.status(403).json({ success:false, message:'Forbidden' });
        }
        const now = new Date();
        const past = new Date(now.getFullYear(), now.getMonth()-1, 1);
        const yil = past.getFullYear();
        const ay = past.getMonth()+1;
        const veri = await monthlyOperations.aylikVeriHesapla(yil, ay);

        // DWH toplamlarını getir ve fark hesapla
        let dwhToplamCiro = null, dwhToplamKisi = null, dwhError = null;
        const mm = ay.toString().padStart(2,'0');
        let pool;
        try {
            pool = new sql.ConnectionPool(dwhConfig);
            await pool.connect();
            const q = await pool.request()
                .input('pattern', sql.VarChar, `%.${mm}.${yil}`)
                .query(`SELECT SUM(CAST(Ciro AS DECIMAL(18,2))) AS toplamCiro, SUM([Kişi Sayısı]) AS toplamKisi FROM [DWH].[dbo].[FactKisiSayisiCiro] WHERE [Şube Kodu]=17672 AND Tarih LIKE @pattern`);
            dwhToplamCiro = parseFloat(q.recordset[0].toplamCiro || 0).toFixed(2);
            dwhToplamKisi = parseInt(q.recordset[0].toplamKisi || 0,10);
        } catch(e) {
            dwhError = e.message;
        } finally { if (pool) try { await pool.close(); } catch(_){} }

        let farkCiro = null, farkKisi = null, farkYuzdeCiro = null;
        if (dwhToplamCiro !== null) {
            farkCiro = (parseFloat(veri.toplamCiro) - parseFloat(dwhToplamCiro)).toFixed(2);
            farkKisi = (veri.toplamKisi - dwhToplamKisi);
            if (parseFloat(dwhToplamCiro) !== 0) {
                farkYuzdeCiro = ((parseFloat(farkCiro)/parseFloat(dwhToplamCiro))*100).toFixed(2);
            }
        }

        return res.json({ success:true, veri, dwh: { dwhToplamCiro, dwhToplamKisi, farkCiro, farkKisi, farkYuzdeCiro, dwhError } });
    } catch (e) {
        return res.status(500).json({ success:false, message:e.message });
    }
});

// Manuel auto-fill tetikleme (geçmiş ay) - sadece atakan.kaplayan
app.post('/monthly-last-month-autofill-run', async (req, res) => {
    try {
        if (!req.session.adUser || !req.session.adUser.toLowerCase().startsWith('atakan.kaplayan')) {
            return res.status(403).json({ success:false, message:'Forbidden' });
        }
        const now = new Date();
        const past = new Date(now.getFullYear(), now.getMonth()-1, 1);
        const yil = past.getFullYear();
        const ay = past.getMonth()+1;
        const sonuc = await monthlyOperations.tamamlaEksikGunler(yil, ay);
        return res.json({ success:true, sonuc });
    } catch(e) {
        return res.status(500).json({ success:false, message:e.message });
    }
});

// Aylık gönderim geçmişi
app.get('/monthly-history', async (req, res) => {
    if (!req.session.login && !req.session.adUser) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const gecmis = await monthlyOperations.getAylikGonderimGecmisi(24); // Son 24 ay
        
        res.json({
            success: true,
            gecmis: gecmis
        });

    } catch (error) {
        console.error('❌ Aylık geçmiş alma hatası:', error);
        res.status(500).json({
            success: false,
            message: 'Geçmiş bilgileri alınamadı',
            error: error.message
        });
    }
});

// HTTP server başlat
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`🚀 HTTP Server çalışıyor - Port: ${PORT}`);
    console.log(`📍 Yerel ağ erişimi: http://10.200.200.6/`);
    console.log(`📍 Localhost erişimi: http://localhost/`);
});

// Bağlantı pool'larını başlat
initializeConnectionPools();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('SIGINT received: closing HTTP server');
    await closeConnectionPools();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM received: closing HTTP server');
    await closeConnectionPools();
    process.exit(0);
});

// 📊 API Routes - yerel ağ için optimize edildi

// 🔍 Veri çekme endpoint'i - geliştirilmiş performans
app.post('/fetch_data', requireLogin, async (req, res) => {
    const { selected_date } = req.body;
    const startTime = Date.now();

    if (!selected_date) {
        return res.status(400).json({
            error: 'Tarih seçilmedi',
            timestamp: new Date().toISOString()
        });
    }

    try {
        const dateObj = new Date(selected_date); const formattedDate = dateObj.toLocaleDateString('tr-TR');

        // 🚀 ÖNCELİK SIRALAMALI SORGU - RESTO sonra DWH
        const [restoData, dwhData] = await Promise.allSettled([
            // ÖNCELİK 1: RESTO'dan kullanıcı verisi kontrol et
            restoConnectionPool.request()
                .input('tarih', sql.VarChar, formattedDate)
                .query(`
                    SELECT TOP 1 
                        ciroavmID,
                        kisi,
                        ciro,
                        tarih,
                        gonderim,
                        tarih as kayitTarihi,
                        subeKodu
                    FROM basar.ciroavm 
                    WHERE CONVERT(date, tarih) = CONVERT(date, @tarih)
                    AND subeKodu = '17672'
                    ORDER BY tarih DESC
                `),

            // ÖNCELİK 2: DWH'dan orijinal veri (sadece RESTO'da yoksa kullanılacak)
            dwhConnectionPool.request()
                .input('tarih', sql.VarChar, formattedDate)
                .query(`
                    SELECT TOP 1 
                        Tarih, 
                        [Kişi Sayısı] as kisiSayisi, 
                        Ciro,
                        [Şube Kodu] as subeKodu
                    FROM [DWH].[dbo].[FactKisiSayisiCiro] 
                    WHERE [Şube Kodu] = '17672' 
                    AND Tarih = @tarih
                    ORDER BY Tarih DESC
                `)
        ]); const responseData = {
            success: true,
            timestamp: new Date().toISOString(),
            responseTime: `${Date.now() - startTime}ms`,
            data: null,
            existing_record: null,
            data_source: null // Hangi kaynaktan geldiğini belirlemek için
        };        // ÖNCELİK 1: RESTO'dan kullanıcı verisi kontrol et
        if (restoData.status === 'fulfilled' && restoData.value.recordset.length > 0) {
            const restoRecord = restoData.value.recordset[0];
            console.log(`✅ RESTO'dan kullanıcı verisi bulundu: ID ${restoRecord.ciroavmID}`);

            // 🔍 UNIFIED APPROACH: gonderimDurum() ile kontrol et
            const durumKontrol = await gonderimDurum(formattedDate);

            responseData.data = {
                id: restoRecord.ciroavmID,
                tarih: restoRecord.tarih,
                kisi_sayisi: restoRecord.kisi,
                ciro: restoRecord.ciro,
                sube_kodu: restoRecord.subeKodu,
                readonly: durumKontrol.sent // gonderimDurum()'dan gelen bilgi
            };

            responseData.existing_record = {
                id: restoRecord.ciroavmID,
                sent: durumKontrol.sent,
                created_at: restoRecord.tarih
            };
            responseData.data_source = 'RESTO';

        } else if (dwhData.status === 'fulfilled' && dwhData.value.recordset.length > 0) {
            // ÖNCELİK 2: DWH'dan orijinal veri (RESTO'da yoksa)
            const dwhRecord = dwhData.value.recordset[0];
            console.log(`📊 DWH'dan orijinal veri bulundu`);

            responseData.data = {
                id: null, // Yeni kayıt
                tarih: dwhRecord.Tarih,
                kisi_sayisi: dwhRecord.kisiSayisi,
                ciro: dwhRecord.Ciro,
                sube_kodu: dwhRecord.subeKodu,
                readonly: false // DWH verisi düzenlenebilir
            };
            responseData.data_source = 'DWH';
        }        // Hata durumlarını logla
        if (restoData.status === 'rejected') {
            console.error('RESTO sorgu hatası:', restoData.reason);
        }
        if (dwhData.status === 'rejected') {
            console.error('DWH sorgu hatası:', dwhData.reason);
        }

        res.json(responseData);

    } catch (error) {
        console.error('Fetch data error:', error);
        res.status(500).json({
            error: 'Veri çekilirken hata oluştu',
            detail: error.message,
            timestamp: new Date().toISOString(),
            responseTime: `${Date.now() - startTime}ms`
        });
    }
});

// 📤 Veri gönderme endpoint'i - geliştirilmiş güvenilirlik
app.post('/submit_data', requireLogin, async (req, res) => {
    const { tarih, kisi_sayisi, ciro, force_update } = req.body;
    const clientIP = req.ip || req.connection.remoteAddress;
    const startTime = Date.now();

    // 🔍 Kullanıcı bilgisi al
    let username = 'Sistem Kullanıcısı';
    if (req.session.adUser) {
        username = req.session.adUser;
    } else if (req.session.login) {
        username = 'Basit Login Kullanıcısı';
    }

    // 🔍 Giriş validasyonu
    const validation = validateSubmissionData({ tarih, kisi_sayisi, ciro });
    if (!validation.isValid) {
        return res.status(400).json({
            error: 'Geçersiz veri',
            details: validation.errors,
            timestamp: new Date().toISOString()
        });
    }

    let transaction;
    try {
        // 🔄 Transaction başlat
        transaction = await restoConnectionPool.transaction();
        await transaction.begin();        // 📋 Mevcut kayıt kontrolü
        const existingCheck = await transaction.request()
            .input('tarih', sql.VarChar, tarih)
            .query(`
                SELECT ciroavmID, gonderim 
                FROM basar.ciroavm 
                WHERE CONVERT(date, tarih) = CONVERT(date, @tarih)
                AND subeKodu = '17672'
            `);

        let recordId;
        let isUpdate = false;

        if (existingCheck.recordset.length > 0) {
            const existing = existingCheck.recordset[0];

            // 🔍 UNIFIED APPROACH: gonderimDurum() ile kontrol et (gonderim flag yerine)
            const durumKontrol = await gonderimDurum(tarih);

            if (durumKontrol.sent && !force_update) {
                await transaction.rollback();
                return res.status(409).json({
                    error: 'Bu tarih için veri zaten gönderilmiş',
                    existing_id: existing.ciroavmID,
                    force_update_required: true,
                    timestamp: new Date().toISOString()
                });
            }// Mevcut kaydı güncelle
            await transaction.request()
                .input('kisi', sql.Int, parseInt(kisi_sayisi))
                .input('ciro', sql.Decimal(18, 2), parseFloat(ciro.replace(',', '.')))
                .input('id', sql.Int, existing.ciroavmID)
                .query(`
                    UPDATE basar.ciroavm 
                    SET kisi = @kisi,
                        ciro = @ciro,
                        gonderim = 0
                    WHERE ciroavmID = @id
                `);

            recordId = existing.ciroavmID;
            isUpdate = true;

        } else {            // Yeni kayıt ekle
            const insertResult = await transaction.request()
                .input('subeKodu', sql.VarChar, '17672')
                .input('kisi', sql.Int, parseInt(kisi_sayisi))
                .input('ciro', sql.Decimal(18, 2), parseFloat(ciro.replace(',', '.')))
                .input('tarih', sql.VarChar, tarih)
                .query(`
                    INSERT INTO basar.ciroavm 
                    (subeKodu, kisi, ciro, tarih, gonderim)
                    OUTPUT INSERTED.ciroavmID
                    VALUES (@subeKodu, @kisi, @ciro, @tarih, 0)
                `);

            recordId = insertResult.recordset[0].ciroavmID;
        }        // 🌐 Emaar API'ye gönderim
        const apiStartTime = Date.now();
        // ✨ API ARRAY FORMAT - API requires an array, not a single object
        const apiPayload = [{
            PROPERTYCODE: "ESM",
            LEASECODE: "t0000967",
            SaleType: "food",
            SalesFromDATE: new Date(tarih).toISOString().split('T')[0],
            NetSalesAmount: parseFloat(ciro.replace(',', '.')),
            NoofTransactions: parseInt(kisi_sayisi),
            SalesFrequency: "Daily"
        }];

        let apiResponse;
        let apiSuccess = false;

        try {
            apiResponse = await axios.post(
                'https://api.emaar.com/emaar/trky/sales',
                apiPayload,
                {
                    headers: {
                        'x-api-key': 'g1LP2jMp65',
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 saniye timeout
                }
            ); apiSuccess = apiResponse.status >= 200 && apiResponse.status < 300;

            // ✨ UNIFIED APPROACH: Artık gonderim flag'ini güncellemiyoruz
            // Başarılı gönderimler personelLog'da statuscode = 201 ile takip ediliyor

        } catch (apiError) {
            console.error('API gönderim hatası:', apiError);
            apiResponse = {
                status: apiError.response?.status || 500,
                data: apiError.message,
                responseTime: Date.now() - apiStartTime
            };
        }        // 📝 İşlem log'u kaydet
        await transaction.request()
            .input('tarih', sql.DateTime, new Date())
            .input('kullanici', sql.VarChar, username)  // ✅ DÜZELTME: userInfo.username yerine username
            .input('ip', sql.VarChar, clientIP)
            .input('tablo', sql.VarChar, 'ciro')  // ✅ DÜZELTME: 'basar.ciroavm' yerine 'ciro' (gonderimDurum() ile uyumlu)
            .input('islem', sql.VarChar, isUpdate ? 'UPDATE' : 'INSERT')
            .input('kayitId', sql.Int, recordId)
            .input('veri', sql.Text, JSON.stringify(apiPayload))  // ✅ API payload'ını ekle
            .input('veri1', sql.VarChar, ciro)
            .input('veri2', sql.VarChar, kisi_sayisi).input('veri3', sql.VarChar, tarih)
            .input('cevap', sql.Text, JSON.stringify(apiResponse?.data || apiResponse))  // ✅ API response'u ekle
            .input('statuscode', sql.Int, apiResponse?.status || 500)  // 🚨 KRİTİK DÜZELTME: statuscode ekle!
            .query(`
                INSERT INTO basar.personelLog 
                (tarih, kullanici, ip, tablo, islem, kayitId, veri, veri1, veri2, veri3, cevap, statuscode)
                VALUES (@tarih, @kullanici, @ip, @tablo, @islem, @kayitId, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)
            `);

        // Transaction'ı commit et
        await transaction.commit();

        res.json({
            success: true,
            record_id: recordId,
            operation: isUpdate ? 'updated' : 'created',
            api_success: apiSuccess,
            api_status: apiResponse?.status,
            api_response: apiResponse?.data,
            timestamp: new Date().toISOString(),
            responseTime: `${Date.now() - startTime}ms`
        });

    } catch (error) {
        if (transaction) {
            await transaction.rollback();
        }

        console.error('Submit data error:', error);
        try {
            await sendErrorEmail({
                ciro,
                kisi: kisi_sayisi,
                tarih,
                kullanici: username,
                source: 'SUBMIT_DATA',
                errorMessage: error.message,
                errorStack: error.stack || '',
                severity: 'ERROR',
                context: { route: '/submit_data', record_id: recordId }
            });
        } catch (mailErr) {
            console.error('Hata emaili gönderilemedi (SUBMIT_DATA):', mailErr.message);
        }
        res.status(500).json({
            error: 'Veri kaydedilirken hata oluştu',
            detail: error.message,
            timestamp: new Date().toISOString(),
            responseTime: `${Date.now() - startTime}ms`
        });
    }
});

// 🔧 Validation helper fonksiyonu
function validateSubmissionData(data) {
    const errors = [];

    if (!data.tarih) {
        errors.push('Tarih boş olamaz');
    } else {
        const dateObj = new Date(data.tarih);
        if (isNaN(dateObj.getTime())) {
            errors.push('Geçersiz tarih formatı');
        }
    }

    if (!data.kisi_sayisi) {
        errors.push('Kişi sayısı boş olamaz');
    } else {
        const kisiSayisi = parseInt(data.kisi_sayisi);
        if (isNaN(kisiSayisi) || kisiSayisi < 0) {
            errors.push('Kişi sayısı geçersiz');
        }
    }

    if (!data.ciro) {
        errors.push('Ciro boş olamaz');
    } else {
        const ciro = parseFloat(data.ciro.replace(',', '.'));
        if (isNaN(ciro) || ciro < 0) {
            errors.push('Ciro değeri geçersiz');
        }
    }

    return {
        isValid: errors.length === 0,
        errors: errors
    };
}

// Geliştirilmiş günlük gönderim durum detayı: son durum, önce/sonra başarısız denemeler
async function gonderimDurumDetay(tarih) {
    let pool;
    try {
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();

        // Son log
        const lastResult = await pool.request()
            .input('tarih', sql.VarChar, tarih)
            .query(`SELECT TOP 1 statuscode, tarih AS logTime FROM basar.personelLog WHERE veri3=@tarih AND tablo='ciro' ORDER BY tarih DESC`);

        // Başarılı log var mı
        const successResult = await pool.request()
            .input('tarih', sql.VarChar, tarih)
            .query(`SELECT TOP 1 tarih FROM basar.personelLog WHERE veri3=@tarih AND tablo='ciro' AND statuscode=201 ORDER BY tarih DESC`);

        let latestSuccessTime = successResult.recordset.length ? successResult.recordset[0].tarih : null;
        let failuresAfterSuccess = 0;
        if (latestSuccessTime) {
            const failAfter = await pool.request()
                .input('tarih', sql.VarChar, tarih)
                .input('succTime', sql.DateTime, latestSuccessTime)
                .query(`SELECT COUNT(1) AS cnt FROM basar.personelLog WHERE veri3=@tarih AND tablo='ciro' AND statuscode<>201 AND tarih > @succTime`);
            failuresAfterSuccess = failAfter.recordset[0].cnt;
        }

        const hasSuccess = !!latestSuccessTime;
        const lastStatusCode = lastResult.recordset.length ? lastResult.recordset[0].statuscode : null;
        const lastIsSuccess = lastStatusCode === 201;
        const degraded = hasSuccess && !lastIsSuccess; // başarı vardı ama en son deneme failed
        const neverSent = !hasSuccess && lastStatusCode === null;
        const onlyFailures = !hasSuccess && lastStatusCode !== null;

        return {
            hasSuccess,
            lastStatusCode,
            lastIsSuccess,
            degraded,
            neverSent,
            onlyFailures,
            failuresAfterSuccess,
            latestSuccessTime
        };
    } catch (e) {
        console.error('gonderimDurumDetay hata', e.message);
        return { error: e.message };
    } finally {
        if (pool) await pool.close();
    }
}