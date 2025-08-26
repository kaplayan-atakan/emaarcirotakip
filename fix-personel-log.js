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

async function fixPersonelLogData() {
    let pool = null;
    
    try {
        console.log('🔧 PERSONEL LOG VERİLERİNİ DÜZELTİYOR');
        console.log('====================================\n');
        
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();
        console.log('✅ RESTO bağlantısı kuruldu\n');
        
        // Tüm yanlış kayıtları kontrol et
        const wrongData = await pool.request().query(`
            SELECT 
                logID,
                veri1,
                veri2,
                veri3,
                kullanici
            FROM basar.personelLog 
            WHERE tablo = 'ciro'
            AND statuscode = '201'
            AND CAST(veri2 AS DECIMAL(18,2)) > CAST(veri1 AS DECIMAL(18,2))
            ORDER BY logID
        `);
        
        console.log(`📊 Yanlış sıralama tespit edilen kayıt sayısı: ${wrongData.recordset.length}\n`);
        
        if (wrongData.recordset.length > 0) {
            console.log('🔄 İlk 5 yanlış kaydı gösteriliyor:');
            wrongData.recordset.slice(0, 5).forEach(row => {
                console.log(`ID: ${row.logID} - veri1: ${row.veri1} (muhtemelen kişi) - veri2: ${row.veri2} (muhtemelen ciro) - Tarih: ${row.veri3}`);
            });
            
            console.log('\n🛠️ Düzeltme işlemi başlıyor...\n');
            
            let duzeltilen = 0;
            for (const row of wrongData.recordset) {
                try {
                    // veri1 ve veri2'yi takas et
                    await pool.request()
                        .input('logID', sql.Int, row.logID)
                        .input('yeniVeri1', sql.VarChar, row.veri2) // eski veri2 (ciro) -> yeni veri1
                        .input('yeniVeri2', sql.VarChar, row.veri1) // eski veri1 (kişi) -> yeni veri2
                        .query(`
                            UPDATE basar.personelLog 
                            SET veri1 = @yeniVeri1, veri2 = @yeniVeri2
                            WHERE logID = @logID
                        `);
                    
                    duzeltilen++;
                    
                    if (duzeltilen % 10 === 0) {
                        console.log(`✅ ${duzeltilen} kayıt düzeltildi...`);
                    }
                    
                } catch (updateError) {
                    console.error(`❌ Kayıt ${row.logID} düzeltme hatası:`, updateError.message);
                }
            }
            
            console.log(`\n🎉 Toplam ${duzeltilen} kayıt düzeltildi!`);
        } else {
            console.log('✅ Düzeltilmesi gereken yanlış kayıt bulunamadı.');
        }
        
        // Düzeltme sonrası kontrol
        console.log('\n🔍 DÜZELTİLEN VERİLERİ KONTROL EDİYOR:');
        console.log('--------------------------------------');
        
        const checkResult = await pool.request().query(`
            SELECT TOP 5
                logID,
                veri1 as Ciro,
                veri2 as Kisi,
                veri3 as Tarih
            FROM basar.personelLog 
            WHERE tablo = 'ciro'
            AND statuscode = '201'
            ORDER BY logID DESC
        `);
        
        checkResult.recordset.forEach(row => {
            console.log(`ID: ${row.logID} - Ciro: ${row.Ciro}₺ - Kişi: ${row.Kisi} - Tarih: ${row.Tarih}`);
        });
        
        // Düzeltme etkisini hesapla
        console.log('\n💰 YENİ MANUEL DÜZELTMELERİN ETKİSİ:');
        console.log('------------------------------------');
        
        const yeniEtki = await pool.request().query(`
            SELECT 
                COUNT(*) as ToplamDuzeltme,
                SUM(CAST(veri1 AS DECIMAL(18,2))) as ToplamCiro,
                SUM(CAST(veri2 AS INT)) as ToplamKisi
            FROM basar.personelLog 
            WHERE tablo = 'ciro'
            AND statuscode = '201'
        `);
        
        if (yeniEtki.recordset.length > 0) {
            const etki = yeniEtki.recordset[0];
            console.log(`📊 Toplam manuel düzeltme: ${etki.ToplamDuzeltme}`);
            console.log(`💰 Toplam ciro: ${etki.ToplamCiro?.toFixed(2) || '0.00'}₺`);
            console.log(`👥 Toplam kişi: ${etki.ToplamKisi || 0}`);
        }
        
    } catch (error) {
        console.error('❌ Düzeltme hatası:', error.message);
    } finally {
        if (pool) await pool.close();
        console.log('\n✅ Düzeltme işlemi tamamlandı.');
    }
}

// Script'i çalıştır
fixPersonelLogData();
