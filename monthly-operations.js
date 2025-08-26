const sql = require('mssql');
const axios = require('axios');
const nodemailer = require('nodemailer');

// Konfigürasyonlar (index.js'den alınacak)
let dwhConfig, restoConfig, API_URL, API_HEADERS;

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

// 📊 Aylık veri hesaplama fonksiyonu (Seçenek 1: RESTO LOG ENTEGRASYONu)
async function aylikVeriHesapla(yil, ay) {
    let dwhPool = null;
    let restoPool = null;
    
    try {
        console.log(`📊 Aylık veri hesaplanıyor: ${ay}/${yil}`);
        
        // DWH bağlantısı
        dwhPool = new sql.ConnectionPool(dwhConfig);
        await dwhPool.connect();
        
        // RESTO bağlantısı
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        
        // DWH'dan o aya ait tüm günlerin verisini al
        const ayBaslangic = `01.${ay.toString().padStart(2, '0')}.${yil}`;
        const aySon = new Date(yil, ay, 0).getDate(); // Ayın son günü
        const aySonTarih = `${aySon.toString().padStart(2, '0')}.${ay.toString().padStart(2, '0')}.${yil}`;
        
        console.log(`📅 Tarih aralığı: ${ayBaslangic} - ${aySonTarih}`);
        
        const dwhResult = await dwhPool.request()
            .query(`
                SELECT 
                    Tarih,
                    Ciro,
                    [Kişi Sayısı] as KisiSayisi
                FROM [DWH].[dbo].[FactKisiSayisiCiro] 
                WHERE [Şube Kodu] = 17672 
                AND CONVERT(datetime, Tarih, 104) >= CONVERT(datetime, '${ayBaslangic}', 104)
                AND CONVERT(datetime, Tarih, 104) <= CONVERT(datetime, '${aySonTarih}', 104)
                ORDER BY CONVERT(datetime, Tarih, 104) ASC
            `);
        
        console.log(`📈 DWH'dan alınan gün sayısı: ${dwhResult.recordset.length}`);
        
        let toplamCiro = 0;
        let toplamKisi = 0;
        let islemDetaylari = [];
        
        // Her gün için manuel gönderim kontrolü yap
        for (const row of dwhResult.recordset) {
            const tarih = row.Tarih;
            let ciro = parseFloat(row.Ciro);
            let kisi = parseInt(row.KisiSayisi);
            let kaynak = 'DWH';
            
            // Tarihi uygun formata çevir (dd.mm.yyyy)
            const tariharr = tarih.split('.');
            const formattedTarih = tariharr[1] + '.' + tariharr[0].padStart(2, '0') + '.' + tariharr[2];
            
            // Manuel gönderim kontrolü
            const manuelResult = await restoPool.request()
                .input('tarih', sql.VarChar, formattedTarih)
                .query(`
                    SELECT TOP 1 
                        veri1 as sentCiro,
                        veri2 as sentKisi,
                        kullanici,
                        tarih as gonderimTarihi
                    FROM basar.personelLog 
                    WHERE veri3 = @tarih 
                    AND statuscode = 201 
                    AND tablo = 'ciro'
                    ORDER BY tarih DESC
                `);
            
            // Manuel gönderim varsa o veriyi kullan
            if (manuelResult.recordset.length > 0) {
                const manuelVeri = manuelResult.recordset[0];
                if (manuelVeri.sentCiro && !isNaN(parseFloat(manuelVeri.sentCiro))) {
                    ciro = parseFloat(manuelVeri.sentCiro);
                    kaynak = 'MANUEL';
                }
                if (manuelVeri.sentKisi && !isNaN(parseInt(manuelVeri.sentKisi))) {
                    kisi = parseInt(manuelVeri.sentKisi);
                }
            }
            
            toplamCiro += ciro;
            toplamKisi += kisi;
            
            islemDetaylari.push({
                tarih: formattedTarih,
                ciro: ciro,
                kisi: kisi,
                kaynak: kaynak
            });
        }
        
        console.log(`💰 Toplam Ciro: ${toplamCiro.toFixed(2)}₺`);
        console.log(`👥 Toplam Kişi: ${toplamKisi}`);
        console.log(`📊 Manuel düzeltme: ${islemDetaylari.filter(x => x.kaynak === 'MANUEL').length} gün`);
        
        return {
            yil,
            ay,
            toplamCiro: parseFloat(toplamCiro.toFixed(2)),
            toplamKisi,
            gunSayisi: islemDetaylari.length,
            manuelDuzeltmeSayisi: islemDetaylari.filter(x => x.kaynak === 'MANUEL').length,
            detaylar: islemDetaylari
        };
        
    } catch (error) {
        console.error('❌ Aylık veri hesaplama hatası:', error);
        throw error;
    } finally {
        if (dwhPool) await dwhPool.close();
        if (restoPool) await restoPool.close();
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
        throw error;
    } finally {
        if (restoPool) await restoPool.close();
    }
}

// 🌐 Monthly Sales API gönderim fonksiyonu
async function monthlyApiGonder(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi = 'SYSTEM') {
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
        await sendMonthlyEmail(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi);
        
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
        
        throw error;
    } finally {
        if (restoPool) await restoPool.close();
    }
}

// 📧 Aylık email gönderim fonksiyonu
async function sendMonthlyEmail(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi) {
    const ayAdlari = [
        '', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
        'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
    ];
    
    const donem = `${ayAdlari[ay]} ${yil}`;
    const ortalamaGunlukCiro = (toplamCiro / 30).toFixed(2);
    const ortalamaGunlukKisi = Math.round(toplamKisi / 30);
    
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
        return [];
    } finally {
        if (restoPool) await restoPool.close();
    }
}

module.exports = {
    setConfig,
    aylikVeriHesapla,
    aylikGonderimKontrol,
    monthlyApiGonder,
    sendMonthlyEmail,
    getAylikGonderimGecmisi
};
