# 09 – Güvenlik & Yetkilendirme

## Mevcut Durum
- Basit session + (opsiyonel) AD doğrulama (öngörülen).
- Bazı credential'lar kod içinde (taşınmalı).

## Riskler
| Risk | Açıklama | Çözüm |
|------|----------|-------|
| Hardcoded şifre | Sızma halinde direkt erişim | .env + Secret Manager |
| HTTP (TLS yok) | Trafik dinlenebilir | Reverse proxy (Nginx) + HTTPS |
| Geniş DB hakları | DROP/ALTER riski | Sadece SELECT/INSERT dar rol |
| Loglarda hassas veri | Mail ile ifşa | Masking + severity filtre |

## Hedef Mimari
- Auth: JWT (HTTP-only cookie) + refresh.
- RBAC Roller: admin, operator, readonly.
- Route guard middleware.

## Örnek Middleware İskeleti
```js
function requireRole(roles=[]) {
  return (req,res,next)=>{
    if(!req.user || (roles.length && !roles.includes(req.user.role))) {
      return res.status(403).json({error:'forbidden'});
    }
    next();
  };
}
```

## Parola & Secret Yönetimi
- .env.local (development)
- Production: Azure Key Vault / AWS SSM Param Store
- Rotasyon: 90 gün

## Audit
- Login denemeleri (timestamp, ip, result)
- Yetki değişiklik logu

## Ek Sertleştirme
- Helmet + rate limit + slow brute-force lockout
- Parametre validation (zod / joi)
- SQL injection: Parametreli sorgular (mssql library zaten destekli)

