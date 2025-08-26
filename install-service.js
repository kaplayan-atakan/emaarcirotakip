const Service = require('node-windows').Service;

// Service objesi oluştur
const svc = new Service({
    name: 'EmaarCiroService',
    description: 'Emaar AVM Ciro ve Kişi Sayısı Gönderim Servisi',
    script: require('path').join(__dirname, 'index.js'),
    nodeOptions: [
        '--harmony',
        '--max_old_space_size=4096'
    ],
    //, workingDirectory: '...'
    //, allowServiceLogon: true
});

// Service yüklendiğinde çalışacak event
svc.on('install', function(){
    console.log('✅ EmaarCiroService başarıyla yüklendi!');
    console.log('🚀 Servis başlatılıyor...');
    svc.start();
});

svc.on('start', function(){
    console.log('✅ EmaarCiroService başarıyla başlatıldı!');
    console.log('🌐 Uygulama http://localhost/ adresinde çalışıyor');
    console.log('🌍 Network erişimi: http://10.200.200.6/');
});

// Service kurulumu
console.log('📦 EmaarCiroService kuruluyor...');
svc.install();