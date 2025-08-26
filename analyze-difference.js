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

async function analyzeDifference() {
    let dwhPool = null;
    let restoPool = null;
    
    try {
        console.log('🔍 GÜNLÜK vs AYLIK CİRO FARK ANALİZİ');
        console.log('=====================================\n');
        
        // RESTO bağlantısı - Aylık veriler
        restoPool = new sql.ConnectionPool(restoConfig);
        await restoPool.connect();
        console.log('✅ RESTO bağlantısı kuruldu');
        
        // DWH bağlantısı - Günlük veriler  
        dwhPool = new sql.ConnectionPool(dwhConfig);
        await dwhPool.connect();
        console.log('✅ DWH bağlantısı kuruldu\n');
        
        // Aylık gönderim verilerini al
        const aylikResult = await restoPool.request().query(`
            SELECT 
                yil,
                ay,
                toplamCiro as AylikToplam,
                toplamKisi,
                gonderimTarihi
            FROM basar.aylikGonderimLog 
            WHERE durum = 'BASARILI'
            ORDER BY yil, ay
        `);
        
        console.log('📊 AYLIK GÖNDERİM VERİLERİ:');
        console.log('---------------------------');
        
        for (const row of aylikResult.recordset) {
            const ayAdlari = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            
            console.log(`${ayAdlari[row.ay]} ${row.yil}: ${row.AylikToplam.toFixed(2)}₺ - ${row.toplamKisi} kişi`);
            
            // Bu ay için DWH'dan günlük toplamı hesapla
            const ayBaslangic = `01.${row.ay.toString().padStart(2, '0')}.${row.yil}`;
            const aySon = new Date(row.yil, row.ay, 0).getDate();
            const aySonTarih = `${aySon.toString().padStart(2, '0')}.${row.ay.toString().padStart(2, '0')}.${row.yil}`;
            
            const dwhResult = await dwhPool.request().query(`
                SELECT 
                    SUM(CAST(Ciro AS DECIMAL(18,2))) as DwhToplam,
                    SUM(CAST([Kişi Sayısı] AS INT)) as DwhKisi,
                    COUNT(*) as GunSayisi
                FROM [DWH].[dbo].[FactKisiSayisiCiro] 
                WHERE [Şube Kodu] = 17672 
                AND CONVERT(datetime, Tarih, 104) >= CONVERT(datetime, '${ayBaslangic}', 104)
                AND CONVERT(datetime, Tarih, 104) <= CONVERT(datetime, '${aySonTarih}', 104)
            `);
            
            if (dwhResult.recordset.length > 0 && dwhResult.recordset[0].DwhToplam) {
                const dwhToplam = parseFloat(dwhResult.recordset[0].DwhToplam);
                const aylikToplam = parseFloat(row.AylikToplam);
                const fark = aylikToplam - dwhToplam;
                const yuzde = ((fark / dwhToplam) * 100);
                
                console.log(`  DWH Ham Toplam: ${dwhToplam.toFixed(2)}₺ - ${dwhResult.recordset[0].DwhKisi} kişi (${dwhResult.recordset[0].GunSayisi} gün)`);
                console.log(`  Fark: ${fark.toFixed(2)}₺ (${yuzde > 0 ? '+' : ''}${yuzde.toFixed(2)}%)`);
                
                // Manuel düzeltmeleri kontrol et
                const manuelResult = await restoPool.request().query(`
                    SELECT 
                        COUNT(*) as ManuelSayisi,
                        SUM(CAST(veri1 AS DECIMAL(18,2))) as ManuelToplam
                    FROM basar.personelLog 
                    WHERE tablo = 'ciro'
                    AND statuscode = 201
                    AND veri3 LIKE '%/${row.ay}/${row.yil}'
                `);
                
                if (manuelResult.recordset[0].ManuelSayisi > 0) {
                    console.log(`  Manuel Düzeltme: ${manuelResult.recordset[0].ManuelSayisi} gün, Toplam: ${manuelResult.recordset[0].ManuelToplam?.toFixed(2) || '0.00'}₺`);
                }
                
                console.log('');
            }
        }
        
        // Ocak ayı için detaylı analiz
        console.log('\n🔍 OCAK 2025 DETAYLI ANALİZ:');
        console.log('-----------------------------');
        
        const detayResult = await dwhPool.request().query(`
            SELECT 
                Tarih,
                CAST(Ciro AS DECIMAL(18,2)) as Ciro,
                [Kişi Sayısı] as Kisi
            FROM [DWH].[dbo].[FactKisiSayisiCiro] 
            WHERE [Şube Kodu] = 17672 
            AND CONVERT(datetime, Tarih, 104) >= CONVERT(datetime, '01.01.2025', 104)
            AND CONVERT(datetime, Tarih, 104) <= CONVERT(datetime, '31.01.2025', 104)
            ORDER BY CONVERT(datetime, Tarih, 104)
        `);
        
        let toplamDwh = 0;
        let toplamKisi = 0;
        
        console.log('Günlük DWH Verileri:');
        detayResult.recordset.slice(0, 10).forEach(row => {
            toplamDwh += parseFloat(row.Ciro);
            toplamKisi += parseInt(row.Kisi);
            console.log(`  ${row.Tarih}: ${row.Ciro.toFixed(2)}₺ - ${row.Kisi} kişi`);
        });
        
        if (detayResult.recordset.length > 10) {
            console.log(`  ... ve ${detayResult.recordset.length - 10} gün daha`);
            
            // Kalanları da topla
            detayResult.recordset.slice(10).forEach(row => {
                toplamDwh += parseFloat(row.Ciro);
                toplamKisi += parseInt(row.Kisi);
            });
        }
        
        console.log(`\nDWH Toplam: ${toplamDwh.toFixed(2)}₺ - ${toplamKisi} kişi`);
        console.log(`Aylık Toplam: 1150770.04₺ - 4208 kişi`);
        console.log(`Fark: ${(1150770.04 - toplamDwh).toFixed(2)}₺`);
        
    } catch (error) {
        console.error('❌ Analiz hatası:', error.message);
        console.error('📍 Detay:', error);
    } finally {
        if (dwhPool) await dwhPool.close();
        if (restoPool) await restoPool.close();
        console.log('\n✅ Analiz tamamlandı.');
    }
}

// Script'i çalıştır
analyzeDifference();
