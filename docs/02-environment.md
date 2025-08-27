# 02 – Ortam Değişkenleri & Yapılandırma

Tüm gizli bilgiler `.env` dosyasına taşınmalıdır. Aşağıdaki örnekler mevcut koddan türetilmiştir. Üretim öncesi şifreleri değiştirin.

```env
# MSSQL – DWH
DWH_DB_USER=basar.sonmez
DWH_DB_PASS=***
DWH_DB_HOST=10.200.200.5
DWH_DB_PORT=33336
DWH_DB_NAME=DWH

# MSSQL – RESTO (LOG)
RESTO_DB_USER=basar.sonmez
RESTO_DB_PASS=***
RESTO_DB_HOST=172.16.14.2
RESTO_DB_NAME=RESTO_16

# EMAIL (SMTP)
SMTP_HOST=mail.apazgroup.com
SMTP_PORT=587
SMTP_USER=sistem@apazgroup.com
SMTP_PASS=***

# EMAAR API
EMAAR_API_URL=https://xxx/sales/api
EMAAR_API_KEY=***
EMAAR_API_AUTHORIZATION=Bearer ***

# AUTH / AD
AD_URL=ldap://dc01.baydoner.local
AD_BASEDN=DC=baydoner,DC=local
AD_DOMAIN=baydoner.local
AD_BIND_USER=svc_ad_read@baydoner.local
AD_BIND_PASS=***

# APP
PORT=3000
LOG_LEVEL=info
```

## Config Yükleme (Next.js)
- Server tarafında (route handlers) `process.env.*` kullan.
- Ortak DB client’ı (singleton) oluştur.

## Güvenlik Notları
- Parola rotasyonu: 90 gün.
- SMTP şifresini uygulama loglarında yazdırmayın.
- AD bind kullanıcısını salt okunur yetkilerle sınırlandırın.

## Sağlık Kontrolleri
- /api/health: DB bağlantısı + hazır memory/state.

## Rate Limit Önerisi
- Günlük manuel gönderimde IP başına 10/5dk.

