const sql = require('mssql');

// Konfigürasyonlar
const dwhConfig = {
    user: 'basar.sonmez',
    password: 'RB&?L9apz',
    server: '10.200.200.5',
    port: 33336,
    database: 'DWH',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 60000
    }
};

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

async function finalAnalysis() {
    let dwhPool = null;
    let restoPool = null;
    
    try {
        console.log('🎯 SON ANALİZ - GERÇEK DURUM TESPİTİ');
        console.log('====================================\n');
        
        // RESTO bağlantısı
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        console.log('✅ RESTO bağlantısı kuruldu');
        
        // DWH bağlantısı  
        dwhPool = new sql.ConnectionPool(dwhConfig);
        await dwhPool.connect();
        console.log('✅ DWH bağlantısı kuruldu\n');
        
        // Başarılı aylık gönderimler
        const aylikResult = await restoPool.request().query(`
            SELECT 
                yil,
                ay,
                toplamCiro,
                toplamKisi,
                gonderimTarihi,
                kullaniciTipi,
                kullaniciAdi
            FROM basar.aylikGonderimLog 
            WHERE durum = 'BASARILI'
            ORDER BY yil, ay
        `);
        
        console.log('📊 BAŞARILI AYLIK GÖNDERİMLER:');
        console.log('-------------------------------');
        
        let genel_aylik_toplam = 0;
        let genel_dwh_toplam = 0;
        let genel_manuel_etkisi = 0;
        
        for (const aylik of aylikResult.recordset) {
            const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            
            console.log(`\n📅 ${ayAdlari[aylik.ay]} ${aylik.yil}:`);
            console.log(`   💰 Aylık Toplam: ${aylik.toplamCiro.toFixed(2)}₺`);
            console.log(`   👥 Kişi: ${aylik.toplamKisi}`);
            console.log(`   📋 ${aylik.kullaniciTipi} - ${aylik.kullaniciAdi}`);
            
            genel_aylik_toplam += parseFloat(aylik.toplamCiro);
            
            // Bu ay için DWH ham verisi
            const ayBaslangic = `01.${aylik.ay.toString().padStart(2, '0')}.${aylik.yil}`;
            const aySon = new Date(aylik.yil, aylik.ay, 0).getDate();
            const aySonTarih = `${aySon.toString().padStart(2, '0')}.${aylik.ay.toString().padStart(2, '0')}.${aylik.yil}`;
            
            const dwhResult = await dwhPool.request().query(`
                SELECT 
                    SUM(CAST(Ciro AS DECIMAL(18,2))) as DwhToplam,
                    SUM(CAST([Kişi Sayısı] AS INT)) as DwhKisi
                FROM [DWH].[dbo].[FactKisiSayisiCiro] 
                WHERE [Şube Kodu] = 17672 
                AND CONVERT(datetime, Tarih, 104) >= CONVERT(datetime, '${ayBaslangic}', 104)
                AND CONVERT(datetime, Tarih, 104) <= CONVERT(datetime, '${aySonTarih}', 104)
            `);
            
            if (dwhResult.recordset[0].DwhToplam) {
                const dwhToplam = parseFloat(dwhResult.recordset[0].DwhToplam);
                genel_dwh_toplam += dwhToplam;
                
                console.log(`   🔍 DWH Ham: ${dwhToplam.toFixed(2)}₺ - ${dwhResult.recordset[0].DwhKisi} kişi`);
                
                const fark = parseFloat(aylik.toplamCiro) - dwhToplam;
                console.log(`   📈 Fark: ${fark > 0 ? '+' : ''}${fark.toFixed(2)}₺`);
                
                // Manuel düzeltmelerin etkisi
                const manuelEtki = await restoPool.request().query(`
                    SELECT 
                        COUNT(*) as ManuelSayisi,
                        SUM(CAST(veri1 AS DECIMAL(18,2))) as ManuelCiroToplami
                    FROM basar.personelLog 
                    WHERE tablo = 'ciro'
                    AND statuscode = '201'
                    AND veri3 LIKE '%/${aylik.ay}/${aylik.yil}'
                `);
                
                if (manuelEtki.recordset[0].ManuelSayisi > 0) {
                    const manuelToplam = parseFloat(manuelEtki.recordset[0].ManuelCiroToplami || 0);
                    genel_manuel_etkisi += manuelToplam;
                    console.log(`   🛠️ Manuel: ${manuelEtki.recordset[0].ManuelSayisi} gün, ${manuelToplam.toFixed(2)}₺ ciro`);
                }
            }
        }
        
        console.log('\n🎯 GENEL ÖZET:');
        console.log('===============');
        console.log(`💰 Toplam Aylık Gönderim: ${genel_aylik_toplam.toFixed(2)}₺`);
        console.log(`🔍 Toplam DWH Ham Veri: ${genel_dwh_toplam.toFixed(2)}₺`);
        console.log(`🛠️ Toplam Manuel Düzeltme: ${genel_manuel_etkisi.toFixed(2)}₺`);
        console.log(`📊 Genel Fark: ${(genel_aylik_toplam - genel_dwh_toplam).toFixed(2)}₺`);
        console.log(`📈 Manuel Düzeltme + DWH: ${(genel_dwh_toplam + genel_manuel_etkisi).toFixed(2)}₺`);
        
        const dogruluk_orani = ((genel_aylik_toplam / genel_dwh_toplam) * 100);
        console.log(`✅ Doğruluk Oranı: %${dogruluk_orani.toFixed(4)}`);
        
        if (Math.abs(genel_aylik_toplam - genel_dwh_toplam) < 1) {
            console.log('🎉 SONUÇ: Günlük ve aylık veriler mükemmel uyumlu!');
        } else if (Math.abs(genel_aylik_toplam - genel_dwh_toplam) < 100) {
            console.log('✅ SONUÇ: Günlük ve aylık veriler çok uyumlu (minimal fark)');
        } else {
            console.log('⚠️ SONUÇ: Günlük ve aylık veriler arasında dikkat edilmesi gereken fark var');
        }
        
        // 20.000 TL farkının açıklaması
        console.log('\n🔍 20.000₺ FARK AÇIKLAMASI:');
        console.log('-----------------------------');
        const fark_tl = genel_aylik_toplam - genel_dwh_toplam;
        
        if (Math.abs(fark_tl) < 100) {
            console.log('✅ Aslında önemli bir fark yok! Bahsedilen 20.000₺ fark muhtemelen:');
            console.log('   - Tarih aralığı farkından kaynaklanıyor olabilir');
            console.log('   - Farklı sorgular kullanılmış olabilir');
            console.log('   - Veri güncellemesi sırasında anlık farklılık olmuş olabilir');
        } else {
            console.log(`📊 Gerçek fark: ${fark_tl.toFixed(2)}₺`);
            console.log('   Bu fark manuel düzeltmelerden kaynaklanıyor olabilir.');
        }
        
    } catch (error) {
        console.error('❌ Final analiz hatası:', error.message);
        console.error('📍 Detay:', error);
    } finally {
        if (dwhPool) await dwhPool.close();
        if (restoPool) await restoPool.close();
        console.log('\n✅ Final analiz tamamlandı.');
    }
}

// Script'i çalıştır
finalAnalysis();
