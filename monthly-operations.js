const sql = require('mssql');
const axios = require('axios');
const nodemailer = require('nodemailer');

// Konfigürasyonlar (index.js'den alınacak)
let dwhConfig, restoConfig, API_URL, API_HEADERS;

// Harici hata email fonksiyonu enjekte edilebilsin (opsiyonel)
let externalErrorNotifier = null;

// Email transporter
const transporter = nodemailer.createTransport({
    host: 'mail.apazgroup.com',
    port: 587,
    secure: false,
    auth: {
        user: 'sistem@apazgroup.com',
        pass: 'Apaz2024!'
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Konfigürasyonları ayarla
function setConfig(dwh, resto, apiUrl, apiHeaders) {
    dwhConfig = dwh;
    restoConfig = resto;
    API_URL = apiUrl;
    API_HEADERS = apiHeaders;
}

// Opsiyonel olarak index.js'deki sendErrorEmail fonksiyonu enjekte edilebilir
function setErrorNotifier(fn) {
    if (typeof fn === 'function') {
        externalErrorNotifier = fn;
    }
}

// Aylık hata bildirimi - artık merkezi alerting modülünü kullanır
function stageSeverity(stage) {
    const s = (stage || '').toUpperCase();
    if (s.includes('API') || s.includes('GONDER')) return 'CRITICAL';
    if (s.includes('EKS') || s.includes('MISSING')) return 'WARN';
    if (s.includes('VERI')) return 'ERROR';
    return 'ERROR';
}

async function sendMonthlyErrorEmail({ stage = 'UNKNOWN', yil = null, ay = null, errorMessage = 'Bilinmeyen hata', errorStack = '', context = {} }) {
    const period = (yil && ay) ? `${ay}/${yil}` : 'Bilinmiyor';
    const payload = {
        kullanici: 'SYSTEM: Monthly Ops',
        source: `MONTHLY_${stage}`,
        errorMessage: `[${period}] ${errorMessage}`,
        errorStack,
        severity: stageSeverity(stage),
        context: { period, stage, ...context }
    };
    try {
        if (externalErrorNotifier) {
            return await externalErrorNotifier(payload);
        } else {
            // Doğrudan merkezi modülü çağır (döngüden kaçınmak için require burada yapılır)
            const { sendErrorEmail } = require('./alerting');
            return await sendErrorEmail(payload);
        }
    } catch (err) {
        console.error('📧❌ Aylık hata emaili gönderilemedi (merkezi):', err.message);
    }
}

//  Aylık veri hesaplama (Yeni Mantık: Günlük gönderilmiş LOG verisi baz alınır)
async function aylikVeriHesapla(yil, ay) {
    let restoPool = null;
    let dwhPool = null; // sadece eksik günler için opsiyonel kontrol
    try {
        console.log(`📊 (YENI) Aylık veri LOG üzerinden hesaplanıyor: ${ay}/${yil}`);
        const mm = ay.toString().padStart(2,'0');
        const daysInMonth = new Date(yil, ay, 0).getDate();

        // Beklenen gün listesi
        const expectedDates = [];
        for (let d=1; d<=daysInMonth; d++) {
            expectedDates.push(`${d.toString().padStart(2,'0')}.${mm}.${yil}`);
        }

        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();

        // LOG'da gönderilmiş başarılı günlük kayıtlar
        const logResult = await restoPool.request()
            .input('pattern', sql.VarChar, `%.${mm}.${yil}`)
            .query(`
                SELECT veri3 as tarih, veri1 as ciro, veri2 as kisi
                FROM basar.personelLog
                WHERE statuscode = 201
                  AND tablo = 'ciro'
                  AND veri3 LIKE @pattern
            `);

        const logMap = new Map();
        for (const row of logResult.recordset) {
            const tarih = row.tarih?.trim();
            if (!tarih) continue;
            // Aynı güne birden çok başarılı gönderim varsa en son/son değeri baz al (overwrite)
            const ciro = parseFloat((row.ciro||'0').toString().replace(',','.')) || 0;
            const kisi = parseInt((row.kisi||'0'),10) || 0;
            logMap.set(tarih, { ciro, kisi, kaynak: 'LOG' });
        }

        let toplamCiro = 0;
        let toplamKisi = 0;
        const detaylar = [];
        const missingDays = [];

        for (const dt of expectedDates) {
            if (logMap.has(dt)) {
                const rec = logMap.get(dt);
                toplamCiro += rec.ciro;
                toplamKisi += rec.kisi;
                detaylar.push({ tarih: dt, ciro: rec.ciro, kisi: rec.kisi, kaynak: rec.kaynak });
            } else {
                missingDays.push(dt);
            }
        }

        // Eksik günleri opsiyonel DWH doğrulaması ile raporlamak için (toplama dahil etmiyoruz!)
        let dwhEksikDetay = [];
        if (missingDays.length > 0) {
            try {
                dwhPool = new sql.ConnectionPool(dwhConfig);
                await dwhPool.connect();
                // DWH'den eksik günler için veri al
                const inClause = missingDays.map(d => `CONVERT(datetime,'${d}',104)`).join(',');
                const dwhMissingQuery = `
                    SELECT Tarih, Ciro, [Kişi Sayısı] AS Kisi
                    FROM [DWH].[dbo].[FactKisiSayisiCiro]
                    WHERE [Şube Kodu] = 17672
                      AND CONVERT(datetime, Tarih, 104) IN (${inClause})
                `;
                const dwhMissing = await dwhPool.request().query(dwhMissingQuery);
                dwhEksikDetay = dwhMissing.recordset.map(r => ({
                    tarih: r.Tarih,
                    ciro: parseFloat(r.Ciro),
                    kisi: parseInt(r.Kisi,10),
                    kaynak: 'DWH_ONLY'
                }));
            } catch(e) {
                console.warn('⚠️ Eksik günler için DWH doğrulama yapılamadı:', e.message);
            }
        }

        console.log(`💰 Toplam Ciro (LOG): ${toplamCiro.toFixed(2)}₺`);
        console.log(`👥 Toplam Kişi (LOG): ${toplamKisi}`);
        console.log(`� Beklenen Gün: ${daysInMonth}, Gönderilmiş Gün: ${detaylar.length}, Eksik: ${missingDays.length}`);

        return {
            yil,
            ay,
            toplamCiro: parseFloat(toplamCiro.toFixed(2)),
            toplamKisi,
            gunSayisi: detaylar.length,
            beklenenGunSayisi: daysInMonth,
            eksikGunler: missingDays,
            eksikGunDwhDetay: dwhEksikDetay, // referans amaçlı
            manuelDuzeltmeSayisi: 0, // Eski alan korunuyor (artık LOG tabanlı)
            detaylar
        };
    } catch (error) {
        console.error('❌ Aylık veri hesaplama hatası:', error);
        await sendMonthlyErrorEmail({ stage: 'VERI_HESAPLA', yil, ay, errorMessage: error.message, errorStack: error.stack });
        throw error;
    } finally {
        if (restoPool) await restoPool.close();
        if (dwhPool) await dwhPool.close();
    }
}

// 🔍 Aylık gönderim kontrol fonksiyonu
async function aylikGonderimKontrol(yil, ay) {
    let restoPool = null;
    
    try {
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        
        const result = await restoPool.request()
            .input('yil', sql.Int, yil)
            .input('ay', sql.Int, ay)
            .query(`
                SELECT TOP 1 
                    id,
                    yil,
                    ay,
                    toplamCiro,
                    toplamKisi,
                    gonderimTarihi,
                    kullaniciTipi,
                    kullaniciAdi,
                    durum
                FROM basar.aylikGonderimLog 
                WHERE yil = @yil AND ay = @ay 
                AND durum = 'BASARILI'
                ORDER BY gonderimTarihi DESC
            `);
        
        if (result.recordset.length > 0) {
            const gonderim = result.recordset[0];
            console.log(`✅ ${ay}/${yil} için aylık gönderim mevcut: ${gonderim.kullaniciTipi} (${gonderim.kullaniciAdi})`);
            return {
                gonderildi: true,
                detay: gonderim
            };
        } else {
            console.log(`📋 ${ay}/${yil} için aylık gönderim bulunamadı`);
            return {
                gonderildi: false,
                detay: null
            };
        }
        
    } catch (error) {
        console.error('❌ Aylık gönderim kontrol hatası:', error);
    await sendMonthlyErrorEmail({ stage: 'GONDERIM_KONTROL', yil, ay, errorMessage: error.message, errorStack: error.stack });
        throw error;
    } finally {
        if (restoPool) await restoPool.close();
    }
}

// 🌐 Monthly Sales API gönderim fonksiyonu
async function monthlyApiGonder(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi = 'SYSTEM', gunSayisi = 30, gunlukDetaylar = []) {
    let restoPool = null;
    
    try {
        console.log(`📤 Monthly Sales API'ye gönderiliyor: ${ay}/${yil}`);
        
        // Monthly Sales API formatına uygun payload oluştur
        const ayIlkGunu = `${ay.toString().padStart(2, '0')}/01/${yil}`;
        
        const payload = [{
            "PROPERTYCODE": "esm",
            "LEASECODE": "t0000967", 
            "SaleType": "food",
            "SalesFromDATE": ayIlkGunu,
            "NetSalesAmount": toplamCiro.toFixed(2).toString(),
            "NoofTransactions": toplamKisi.toString(),
            "SalesFrequency": "Monthly"
        }];
        
        console.log(`📊 Monthly Payload: ${JSON.stringify(payload, null, 2)}`);
        
        // API'ye gönder
        const response = await axios.post(API_URL, payload, { headers: API_HEADERS });
        console.log(`📈 Monthly API Response - Status: ${response.status}, Data: ${JSON.stringify(response.data)}`);
        
        // RESTO bağlantısı
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        
        // aylikGonderimLog tablosuna kaydet
        await restoPool.request()
            .input('yil', sql.Int, yil)
            .input('ay', sql.Int, ay)
            .input('toplamCiro', sql.Decimal(18, 2), toplamCiro)
            .input('toplamKisi', sql.Int, toplamKisi)
            .input('kullaniciTipi', sql.VarChar, kullaniciTipi)
            .input('kullaniciAdi', sql.VarChar, kullaniciAdi)
            .input('apiCevap', sql.Text, JSON.stringify(response.data))
            .input('durum', sql.VarChar, 'BASARILI')
            .query(`
                INSERT INTO basar.aylikGonderimLog 
                (yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi, apiCevap, durum) 
                VALUES (@yil, @ay, @toplamCiro, @toplamKisi, @kullaniciTipi, @kullaniciAdi, @apiCevap, @durum)
            `);
        
        // personelLog'a da kaydet (uyumluluk için)
        await restoPool.request()
            .input('tarih', sql.DateTime, new Date())
            .input('ip', sql.VarChar, kullaniciTipi)
            .input('kullanici', sql.VarChar, kullaniciAdi)
            .input('tablo', sql.VarChar, 'aylık_ciro')
            .input('veri', sql.Text, JSON.stringify(payload))
            .input('veri1', sql.VarChar, toplamCiro.toString())
            .input('veri2', sql.VarChar, toplamKisi.toString())
            .input('veri3', sql.VarChar, `${ay}/${yil}`)
            .input('cevap', sql.Text, JSON.stringify(response.data))
            .input('statuscode', sql.Int, response.status)
            .query(`
                INSERT INTO basar.personelLog 
                (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode) 
                VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)
            `);
        
        // Email gönder
    await sendMonthlyEmail(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi, gunSayisi, gunlukDetaylar);
        
        console.log(`✅ [BAŞARILI] Aylık veri gönderildi! API Status: ${response.status}, Dönem: ${ay}/${yil}`);
        
        return {
            success: true,
            status: response.status,
            data: response.data,
            payload: payload
        };
        
    } catch (error) {
        console.error(`❌ [HATA] Monthly API gönderim başarısız! Dönem: ${ay}/${yil}, Hata: ${error.message}`);
        
        // Hata durumunda da kaydet
        if (!restoPool) {
            restoPool = new sql.ConnectionPool(restoConfig);
            await restoPool.connect();
        }
        
        await restoPool.request()
            .input('yil', sql.Int, yil)
            .input('ay', sql.Int, ay)
            .input('toplamCiro', sql.Decimal(18, 2), toplamCiro)
            .input('toplamKisi', sql.Int, toplamKisi)
            .input('kullaniciTipi', sql.VarChar, kullaniciTipi)
            .input('kullaniciAdi', sql.VarChar, kullaniciAdi)
            .input('apiCevap', sql.Text, error.message)
            .input('durum', sql.VarChar, 'HATA')
            .query(`
                INSERT INTO basar.aylikGonderimLog 
                (yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi, apiCevap, durum) 
                VALUES (@yil, @ay, @toplamCiro, @toplamKisi, @kullaniciTipi, @kullaniciAdi, @apiCevap, @durum)
            `);
    await sendMonthlyErrorEmail({ stage: 'API_GONDER', yil, ay, errorMessage: error.message, errorStack: error.stack, context: { toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi } });
        throw error;
    } finally {
        if (restoPool) await restoPool.close();
    }
}

// 📧 Aylık email gönderim fonksiyonu
async function sendMonthlyEmail(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi, gunSayisi = 30, gunlukDetaylar = []) {
    const ayAdlari = [
        '', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
        'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
    ];
    
    const donem = `${ayAdlari[ay]} ${yil}`;
    const divisor = gunSayisi > 0 ? gunSayisi : 1;
    const ortalamaGunlukCiro = (toplamCiro / divisor).toFixed(2);
    const ortalamaGunlukKisi = Math.round(toplamKisi / divisor);
    
    // Günlük detayları tarihe göre sırala
    const siraliDetaylar = [...gunlukDetaylar].sort((a, b) => {
        const dateA = new Date(a.tarih.split('.').reverse().join('-'));
        const dateB = new Date(b.tarih.split('.').reverse().join('-'));
        return dateA - dateB;
    });
    
    const mailOptions = {
        from: 'sistem@apazgroup.com',
        to: [
            'atakan.kaplayan@apazgroup.com',
            'asli.senankesekler@apazgroup.com',
            'simge.civgin@apazgroup.com',
            'pinar.eraslan@apazgroup.com',
            'harun.ozdemir@apazgroup.com'
        ],
        subject: `📊 Aylık Ciro Raporu Gönderildi - ${donem}`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px; font-weight: 600;">📊 Aylık Ciro Raporu</h1>
                    <p style="margin: 10px 0 0 0; opacity: 0.9; font-size: 16px;">${donem} Dönemi</p>
                </div>
                
                <div style="padding: 30px;">
                    <div style="background: #f8f9fa; border-radius: 12px; padding: 25px; margin-bottom: 25px;">
                        <h2 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
                            📈 Aylık Özet
                        </h2>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
                            <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                <div style="color: #27ae60; font-size: 24px; font-weight: bold;">${toplamCiro.toLocaleString('tr-TR')}₺</div>
                                <div style="color: #7f8c8d; font-size: 14px; margin-top: 5px;">Toplam Ciro</div>
                            </div>
                            <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                <div style="color: #3498db; font-size: 24px; font-weight: bold;">${toplamKisi.toLocaleString('tr-TR')}</div>
                                <div style="color: #7f8c8d; font-size: 14px; margin-top: 5px;">Toplam Kişi</div>
                            </div>
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                            <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                <div style="color: #e67e22; font-size: 20px; font-weight: bold;">${ortalamaGunlukCiro}₺</div>
                                <div style="color: #7f8c8d; font-size: 14px; margin-top: 5px;">Günlük Ortalama Ciro</div>
                            </div>
                            <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                <div style="color: #9b59b6; font-size: 20px; font-weight: bold;">${ortalamaGunlukKisi}</div>
                                <div style="color: #7f8c8d; font-size: 14px; margin-top: 5px;">Günlük Ortalama Kişi</div>
                            </div>
                        </div>
                    </div>
                    
                    <div style="background: #fff; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
                        <h3 style="color: #495057; margin: 0 0 15px 0; font-size: 16px;">🔄 Gönderim Detayları</h3>
                        <div style="color: #6c757d; font-size: 14px; line-height: 1.6;">
                            <p style="margin: 5px 0;"><strong>Gönderim Türü:</strong> ${kullaniciTipi}</p>
                            <p style="margin: 5px 0;"><strong>Gönderen:</strong> ${kullaniciAdi}</p>
                            <p style="margin: 5px 0;"><strong>Tarih:</strong> ${new Date().toLocaleString('tr-TR')}</p>
                            <p style="margin: 5px 0;"><strong>API:</strong> Monthly Sales API</p>
                        </div>
                    </div>
                    
                    ${siraliDetaylar.length > 0 ? `
                    <div style="background: #fff; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
                        <h3 style="color: #495057; margin: 0 0 20px 0; font-size: 16px;">📊 Günlük Gönderimler Tablosu</h3>
                        <div style="overflow-x: auto;">
                            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                <thead>
                                    <tr style="background: #f8f9fa;">
                                        <th style="padding: 12px 8px; text-align: left; border: 1px solid #dee2e6; font-weight: 600; color: #495057;">Tarih</th>
                                        <th style="padding: 12px 8px; text-align: right; border: 1px solid #dee2e6; font-weight: 600; color: #495057;">Ciro (₺)</th>
                                        <th style="padding: 12px 8px; text-align: right; border: 1px solid #dee2e6; font-weight: 600; color: #495057;">Kişi Sayısı</th>
                                        <th style="padding: 12px 8px; text-align: center; border: 1px solid #dee2e6; font-weight: 600; color: #495057;">Kaynak</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${siraliDetaylar.map((detay, index) => `
                                        <tr style="background: ${index % 2 === 0 ? '#fff' : '#f8f9fa'};">
                                            <td style="padding: 10px 8px; border: 1px solid #dee2e6; color: #495057;">${detay.tarih}</td>
                                            <td style="padding: 10px 8px; border: 1px solid #dee2e6; text-align: right; color: #27ae60; font-weight: 500;">${detay.ciro.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                                            <td style="padding: 10px 8px; border: 1px solid #dee2e6; text-align: right; color: #3498db; font-weight: 500;">${detay.kisi.toLocaleString('tr-TR')}</td>
                                            <td style="padding: 10px 8px; border: 1px solid #dee2e6; text-align: center;">
                                                <span style="background: ${detay.kaynak === 'LOG' ? '#28a745' : '#6c757d'}; color: white; padding: 3px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;">
                                                    ${detay.kaynak === 'LOG' ? 'Gönderildi' : detay.kaynak}
                                                </span>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                                <tfoot>
                                    <tr style="background: #e9ecef; font-weight: 600;">
                                        <td style="padding: 12px 8px; border: 1px solid #dee2e6; color: #495057;">TOPLAM</td>
                                        <td style="padding: 12px 8px; border: 1px solid #dee2e6; text-align: right; color: #27ae60; font-weight: bold;">${toplamCiro.toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                                        <td style="padding: 12px 8px; border: 1px solid #dee2e6; text-align: right; color: #3498db; font-weight: bold;">${toplamKisi.toLocaleString('tr-TR')}</td>
                                        <td style="padding: 12px 8px; border: 1px solid #dee2e6; text-align: center; color: #495057;">${siraliDetaylar.length} gün</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                        ${gunSayisi < new Date(yil, ay, 0).getDate() ? `
                        <div style="margin-top: 15px; padding: 10px; background: #fff3cd; border-radius: 6px; border-left: 3px solid #ffc107;">
                            <p style="margin: 0; color: #856404; font-size: 13px;">
                                ⚠️ <strong>Not:</strong> Bu ay toplam ${new Date(yil, ay, 0).getDate()} gün olmasına rağmen ${gunSayisi} gün verisi gönderilmiştir. ${new Date(yil, ay, 0).getDate() - gunSayisi} gün eksik.
                            </p>
                        </div>
                        ` : ''}
                    </div>
                    ` : ''}
                    
                    <div style="margin-top: 25px; padding: 15px; background: #d4edda; border-radius: 8px; border-left: 4px solid #28a745;">
                        <p style="margin: 0; color: #155724; font-size: 14px;">
                            ✅ <strong>Başarılı:</strong> ${donem} dönemi aylık ciro raporu Emaar Monthly Sales API'sine başarıyla gönderilmiştir.
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
        console.log(`📧✅ Aylık email başarıyla gönderildi: ${kullaniciAdi} (${kullaniciTipi}) tarafından ${donem} raporu`);
    } catch (error) {
        console.error('📧❌ Aylık email gönderim hatası:', error);
    }
}

// 📋 Aylık gönderim geçmişi listesi
async function getAylikGonderimGecmisi(limit = 12) {
    let restoPool = null;
    
    try {
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        
        const result = await restoPool.request()
            .input('limit', sql.Int, limit)
            .query(`
                SELECT TOP (@limit)
                    yil,
                    ay,
                    toplamCiro,
                    toplamKisi,
                    gonderimTarihi,
                    kullaniciTipi,
                    kullaniciAdi,
                    durum
                FROM basar.aylikGonderimLog 
                ORDER BY yil DESC, ay DESC, gonderimTarihi DESC
            `);
        
        return result.recordset;
        
    } catch (error) {
        console.error('❌ Aylık gönderim geçmişi alınamadı:', error);
    await sendMonthlyErrorEmail({ stage: 'GECMIS_OKU', errorMessage: error.message, errorStack: error.stack, context: { limit } });
        return [];
    } finally {
        if (restoPool) await restoPool.close();
    }
}

module.exports = {
    setConfig,
    setErrorNotifier,
    aylikVeriHesapla,
    aylikGonderimKontrol,
    monthlyApiGonder,
    sendMonthlyEmail,
    getAylikGonderimGecmisi,
    tamamlaEksikGunler
};

// 🔄 Eksik günlük verileri otomatik (manuel gibi) tamamlama
async function tamamlaEksikGunler(yil, ay) {
    console.log(`🔄 Eksik gün tamamlama başlıyor: ${ay}/${yil}`);
    let restoPool = null;
    let dwhPool = null;
    const baslangic = Date.now();
    try {
        const ilkVeri = await aylikVeriHesapla(yil, ay); // mevcut eksikleri al
        if (ilkVeri.eksikGunler.length === 0) {
            console.log('✅ Eksik gün yok, tamamlama gerekmiyor');
            return { success: true, alreadyComplete: true, sentDays: [], notFoundDays: [], failedDays: [], durationMs: Date.now()-baslangic };
        }

        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        dwhPool = new sql.ConnectionPool(dwhConfig);
        await dwhPool.connect();

        const sentDays = [];
        const notFoundDays = [];
        const failedDays = [];

        for (const dt of ilkVeri.eksikGunler) {
            const [dd, mm, yyyy] = dt.split('.');
            const isoDate = `${yyyy}-${mm}-${dd}`;

            // DWH'den gün verisi
            let dwhRec;
            try {
                const r = await dwhPool.request()
                    .input('tarih', sql.VarChar, dt)
                    .query(`SELECT TOP 1 Tarih, CAST(Ciro AS DECIMAL(18,2)) AS Ciro, [Kişi Sayısı] AS Kisi FROM [DWH].[dbo].[FactKisiSayisiCiro] WHERE [Şube Kodu] = 17672 AND Tarih = @tarih`);
                if (r.recordset.length === 0) {
                    console.warn(`⚠️ DWH'de bulunamadı: ${dt}`);
                    notFoundDays.push(dt);
                    continue;
                }
                dwhRec = r.recordset[0];
            } catch (e) {
                console.error(`❌ DWH sorgu hatası (${dt}):`, e.message);
                failedDays.push(dt);
                continue;
            }

            // Idempotent kontrol (bir yandan başka process eklemiş mi?)
            try {
                const kontrol = await restoPool.request()
                    .input('tarih', sql.VarChar, dt)
                    .query(`SELECT TOP 1 1 FROM basar.personelLog WHERE veri3 = @tarih AND tablo='ciro' AND statuscode=201`);
                if (kontrol.recordset.length > 0) {
                    console.log(`ℹ️ Zaten gönderilmiş (yarış durumu): ${dt}`);
                    sentDays.push(dt);
                    continue;
                }
            } catch (e) {
                console.warn('Idempotent kontrol hatası:', e.message);
            }

            const ciro = parseFloat(dwhRec.Ciro).toFixed(2);
            const kisi = parseInt(dwhRec.Kisi,10);
            const payload = [{
                SalesFromDATE: isoDate,
                SalesToDATE: isoDate,
                NetSalesAmount: ciro,               // unified string format (2 decimals)
                NoofTransactions: kisi.toString(),  // unified string format
                SalesFrequency: 'Daily',
                PropertyCode: 'ESM',
                LeaseCode: 't0000967',
                SaleType: 'food'
            }];

            try {
                const resp = await axios.post(API_URL, payload, { headers: API_HEADERS });
                await restoPool.request()
                    .input('tarih', sql.DateTime, new Date())
                    .input('ip', sql.VarChar, 'AUTO-FILL')
                    .input('kullanici', sql.VarChar, 'SYSTEM: Missing Day AutoFill')
                    .input('tablo', sql.VarChar, 'ciro')
                    .input('veri', sql.Text, JSON.stringify(payload))
                    .input('veri1', sql.VarChar, ciro)
                    .input('veri2', sql.VarChar, kisi.toString())
                    .input('veri3', sql.VarChar, dt)
                    .input('cevap', sql.Text, JSON.stringify(resp.data))
                    .input('statuscode', sql.Int, resp.status)
                    .query(`INSERT INTO basar.personelLog (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode) VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)`);
                console.log(`✅ Eksik gün gönderildi: ${dt}`);
                sentDays.push(dt);
            } catch (e) {
                console.error(`❌ Günlük auto-fill gönderim hatası (${dt}):`, e.message);
                failedDays.push(dt);
                try {
                    await restoPool.request()
                        .input('tarih', sql.DateTime, new Date())
                        .input('ip', sql.VarChar, 'AUTO-FILL')
                        .input('kullanici', sql.VarChar, 'SYSTEM: Missing Day AutoFill')
                        .input('tablo', sql.VarChar, 'ciro_error')
                        .input('veri', sql.Text, JSON.stringify({ payload, error: e.message }))
                        .input('veri1', sql.VarChar, ciro)
                        .input('veri2', sql.VarChar, kisi.toString())
                        .input('veri3', sql.VarChar, dt)
                        .input('cevap', sql.Text, e.stack || '')
                        .input('statuscode', sql.Int, 500)
                        .query(`INSERT INTO basar.personelLog (tarih, ip, kullanici, tablo, veri, veri1, veri2, veri3, cevap, statuscode) VALUES (@tarih, @ip, @kullanici, @tablo, @veri, @veri1, @veri2, @veri3, @cevap, @statuscode)`);
                } catch (logErr) {
                    console.error('Ek hata loglanamadı:', logErr.message);
                }
            }
        }

        return {
            success: failedDays.length === 0 && notFoundDays.length === 0,
            sentDays,
            notFoundDays,
            failedDays,
            durationMs: Date.now()-baslangic
        };
    } catch (error) {
        await sendMonthlyErrorEmail({ stage: 'EKSİK_GUN_TAMAMLA', yil, ay, errorMessage: error.message, errorStack: error.stack });
        throw error;
    } finally {
        if (restoPool) await restoPool.close();
        if (dwhPool) await dwhPool.close();
    }
}
