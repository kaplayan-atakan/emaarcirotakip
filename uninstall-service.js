const Service = require('node-windows').Service;

// Service objesi oluştur
const svc = new Service({
    name: 'EmaarCiroService',
    description: 'Emaar AVM Ciro ve Kişi Sayısı Gönderim Servisi',
    script: require('path').join(__dirname, 'index.js'),
});

// Service kaldırıldığında çalışacak event
svc.on('uninstall', function(){
    console.log('✅ EmaarCiroService başarıyla kaldırıldı!');
    console.log('Servis Windows Services listesinden tamamen silindi.');
});

// Service kaldırma
console.log('🗑️ EmaarCiroService kaldırılıyor...');
svc.uninstall();