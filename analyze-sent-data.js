const sql = require('mssql');

const restoConfig = {
    user: 'basar.sonmez',
    password: 'RB&?L9apz',
    server: '172.16.14.2',
    database: 'RESTO_16',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 60000
    }
};

async function analyzeGonderilenler() {
    let pool = null;
    
    try {
        console.log('📤 GÖNDERİLEN VERİLERİN ANALİZİ');
        console.log('===============================\n');
        
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();
        console.log('✅ RESTO bağlantısı kuruldu\n');
        
        // 1. Tüm gönderilen verileri listele (personelLog'dan)
        console.log('📋 EMAAR API\'SİNE GÖNDERİLEN TÜM VERİLER:');
        console.log('------------------------------------------');
        
        const gonderilenler = await pool.request().query(`
            SELECT 
                logID,
                tarih as GonderimTarihi,
                veri3 as SatisTarihi,
                CAST(veri1 AS DECIMAL(18,2)) as GonderilenCiro,
                CAST(veri2 AS INT) as GonderilenKisi,
                kullanici,
                cevap
            FROM basar.personelLog 
            WHERE tablo = 'ciro'
            AND statuscode = '201'
            ORDER BY logID ASC
        `);
        
        console.log(`📊 Toplam ${gonderilenler.recordset.length} günlük veri gönderilmiş:\n`);
        
        let toplamGonderilenCiro = 0;
        let toplamGonderilenKisi = 0;
        
        // Ay bazında grupla
        const ayBazinda = {};
        
        gonderilenler.recordset.forEach((row, index) => {
            // Tarih parse et
            const tarihParts = row.SatisTarihi.split('.');
            if (tarihParts.length === 3) {
                const ay = parseInt(tarihParts[1]);
                const yil = parseInt(tarihParts[2]);
                const ayKey = `${yil}-${ay}`;
                
                if (!ayBazinda[ayKey]) {
                    ayBazinda[ayKey] = {
                        yil: yil,
                        ay: ay,
                        gunler: [],
                        toplamCiro: 0,
                        toplamKisi: 0
                    };
                }
                
                ayBazinda[ayKey].gunler.push(row);
                ayBazinda[ayKey].toplamCiro += parseFloat(row.GonderilenCiro);
                ayBazinda[ayKey].toplamKisi += parseInt(row.GonderilenKisi);
            }
            
            toplamGonderilenCiro += parseFloat(row.GonderilenCiro);
            toplamGonderilenKisi += parseInt(row.GonderilenKisi);
            
            // İlk 10 kaydı detaylı göster
            if (index < 10) {
                console.log(`${index + 1}. ${row.SatisTarihi}: ${row.GonderilenCiro.toFixed(2)}₺ - ${row.GonderilenKisi} kişi`);
                console.log(`   📅 Gönderim: ${new Date(row.GonderimTarihi).toLocaleString('tr-TR')}`);
                console.log(`   👤 ${row.kullanici}\n`);
            }
        });
        
        if (gonderilenler.recordset.length > 10) {
            console.log(`   ... ve ${gonderilenler.recordset.length - 10} gün daha\n`);
        }
        
        console.log('💰 GÜNLÜK GÖNDERİMLERİN TOPLAMI:');
        console.log('----------------------------------');
        console.log(`📊 Toplam Ciro: ${toplamGonderilenCiro.toFixed(2)}₺`);
        console.log(`👥 Toplam Kişi: ${toplamGonderilenKisi}\n`);
        
        // 2. Ay bazında karşılaştırma
        console.log('📅 AY BAZINDA KARŞILAŞTIRMA:');
        console.log('-----------------------------');
        
        const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
        
        for (const [ayKey, ayVeri] of Object.entries(ayBazinda)) {
            console.log(`\n📆 ${ayAdlari[ayVeri.ay]} ${ayVeri.yil}:`);
            console.log(`   📤 Günlük gönderimler: ${ayVeri.gunler.length} gün`);
            console.log(`   💰 Günlük toplam: ${ayVeri.toplamCiro.toFixed(2)}₺`);
            console.log(`   👥 Günlük kişi: ${ayVeri.toplamKisi}`);
            
            // Bu ay için aylık gönderim var mı?
            const aylikGonderim = await pool.request().query(`
                SELECT 
                    toplamCiro,
                    toplamKisi,
                    gonderimTarihi,
                    kullaniciTipi,
                    kullaniciAdi
                FROM basar.aylikGonderimLog 
                WHERE yil = ${ayVeri.yil} AND ay = ${ayVeri.ay}
                AND durum = 'BASARILI'
                ORDER BY gonderimTarihi DESC
            `);
            
            if (aylikGonderim.recordset.length > 0) {
                const aylik = aylikGonderim.recordset[0];
                console.log(`   📊 Aylık gönderim: ${aylik.toplamCiro.toFixed(2)}₺ - ${aylik.toplamKisi} kişi`);
                
                const fark = parseFloat(aylik.toplamCiro) - ayVeri.toplamCiro;
                console.log(`   📈 Fark: ${fark > 0 ? '+' : ''}${fark.toFixed(2)}₺`);
                
                if (Math.abs(fark) > 1000) {
                    console.log(`   ⚠️  BÜYÜK FARK TESPİT EDİLDİ!`);
                }
            } else {
                console.log(`   ❌ Bu ay için aylık gönderim bulunamadı`);
            }
        }
        
        // 3. Potansiyel problemleri kontrol et
        console.log('\n🔍 POTANSİYEL PROBLEM KONTROLLÜ:');
        console.log('--------------------------------');
        
        // Aynı gün için birden fazla gönderim var mı?
        const duplikatlar = await pool.request().query(`
            SELECT 
                veri3 as Tarih,
                COUNT(*) as GonderimSayisi,
                STRING_AGG(CAST(veri1 AS VARCHAR), ', ') as CiroListesi
            FROM basar.personelLog 
            WHERE tablo = 'ciro'
            AND statuscode = '201'
            GROUP BY veri3
            HAVING COUNT(*) > 1
            ORDER BY veri3
        `);
        
        if (duplikatlar.recordset.length > 0) {
            console.log(`⚠️ ${duplikatlar.recordset.length} tarih için birden fazla gönderim tespit edildi:`);
            duplikatlar.recordset.forEach(dup => {
                console.log(`   📅 ${dup.Tarih}: ${dup.GonderimSayisi} kez gönderilmiş - Cirolar: [${dup.CiroListesi}]`);
            });
        } else {
            console.log('✅ Duplikat gönderim bulunamadı');
        }
        
        // 4. Son özet
        console.log('\n🎯 SONUÇ ÖZETİ:');
        console.log('================');
        console.log(`📤 Toplam günlük gönderim: ${gonderilenler.recordset.length} gün`);
        console.log(`💰 Günlük gönderimler toplamı: ${toplamGonderilenCiro.toFixed(2)}₺`);
        console.log(`👥 Günlük gönderimler kişi: ${toplamGonderilenKisi}`);
        
        // Aylık gönderimlerle karşılaştır
        const aylikToplam = await pool.request().query(`
            SELECT 
                SUM(toplamCiro) as AylikToplamCiro,
                SUM(toplamKisi) as AylikToplamKisi,
                COUNT(*) as AylikGonderimSayisi
            FROM basar.aylikGonderimLog 
            WHERE durum = 'BASARILI'
        `);
        
        if (aylikToplam.recordset.length > 0) {
            const aylik = aylikToplam.recordset[0];
            console.log(`📊 Aylık gönderimler toplamı: ${aylik.AylikToplamCiro.toFixed(2)}₺`);
            console.log(`👥 Aylık gönderimler kişi: ${aylik.AylikToplamKisi}`);
            
            const genel_fark = parseFloat(aylik.AylikToplamCiro) - toplamGonderilenCiro;
            console.log(`🔄 Genel fark: ${genel_fark > 0 ? '+' : ''}${genel_fark.toFixed(2)}₺`);
            
            if (Math.abs(genel_fark) >= 15000) {
                console.log('🚨 20.000₺ civarı fark TESPİT EDİLDİ!');
                console.log('   Bu fark şu sebeplerden kaynaklanıyor olabilir:');
                console.log('   - Aylık hesaplamada farklı veri kaynaği kullanılması');
                console.log('   - Manuel düzeltmelerin aylık hesaplamaya dahil edilmemesi');
                console.log('   - Tarih aralığı farklılıkları');
            } else {
                console.log('✅ Önemli bir fark tespit edilmedi');
            }
        }
        
    } catch (error) {
        console.error('❌ Analiz hatası:', error.message);
        console.error('📍 Detay:', error);
    } finally {
        if (pool) await pool.close();
        console.log('\n✅ Gönderilen veriler analizi tamamlandı.');
    }
}

// Script'i çalıştır
analyzeGonderilenler().then(() => {
    console.log('✅ Script başarıyla tamamlandı');
    process.exit(0);
}).catch((error) => {
    console.error('❌ Script hatası:', error);
    process.exit(1);
});
