# Ticaret Paneli — Hepsiburada · Trendyol · N11 · Çiçeksepeti

Siparişleri otomatik çeker, satılan ürünlerin stoğunu **otomatik düşürür** ve yeni stok değerini **anında yapılandırdığın her platforma geri yazar** — hangi kanaldan satıldığına bakılmaksızın, tüm mağazaların her zaman aynı gerçek stoğu gösterir.

Sadece kullandığın platformların `.env` bilgilerini doldurman yeterli; boş bıraktığın bir platform panelde otomatik olarak "yapılandırılmadı" görünür ve devre dışı kalır — hiçbir şeyi kod değiştirmeden açıp kapatabilirsin.

## 1. Kurulum

```bash
cd siparis-paneli
npm install
cp .env.example .env
```

`.env` dosyasını, kullandığın platformlar için doldur:

- **Hepsiburada**: Merchant panel → Entegrasyon Bilgileri → `HB_MERCHANT_ID`, `HB_USERNAME`, `HB_PASSWORD`
- **Trendyol**: Satıcı Panel → Hesap Bilgilerim → Entegrasyon Bilgileri → `TY_SELLER_ID`, `TY_API_KEY`, `TY_API_SECRET`
- **N11**: Mağaza Yönetim Paneli → Hesabım → Api Hesapları → `N11_APP_KEY`, `N11_APP_SECRET`
- **Çiçeksepeti**: Bayi paneli üzerinden destek talebiyle alınan `CS_API_KEY` (bkz. aşağıdaki not)
- `PANEL_PASSWORD`: paneli açarken sorulacak şifre

## 2. Çalıştırma

```bash
npm start
```

Tarayıcıda **http://localhost:3000**. Üç sekme var: **Siparişler**, **Stok** (her yapılandırılmış platform için bir sütun otomatik açılır), **Senkron Günlüğü**.

## 3. Otomatik stok düşürme nasıl çalışıyor

Arka planda (varsayılan 15 dakikada bir):
1. Yapılandırdığın her platformdan yeni siparişleri çeker.
2. Daha önce işlenmemiş her siparişin kalemlerini barkod/SKU'ya göre kataloğundaki ürünle eşleştirir ve **merkezi stoğu satılan adet kadar düşürür** (aynı sipariş tekrar görülürse tekrar düşülmez).
3. Stoğu değişen her ürünü **yapılandırdığın tüm platformlara** hemen geri yazar.
4. Sonuç "Senkron Günlüğü" sekmesinde platform bazında görünür (✓ / ✗ ve hata mesajı).

## 4. Entegrasyonların doğrulama durumu

| Platform | Sipariş çekme | Stok geri yazma | Durum |
|---|---|---|---|
| Hepsiburada | `oms-external.hepsiburada.com/packages` | `listing-external.hepsiburada.com/.../stock-uploads` (XML) | Resmi dokümandan doğrulandı |
| Trendyol | `apigw.trendyol.com/.../v2/orders` | `apigw.trendyol.com/.../price-and-inventory` (JSON) | Resmi dokümandan doğrulandı |
| N11 | `api.n11.com/rest/delivery/v1/shipmentPackages` | `api.n11.com/ms/product/tasks/price-stock-update` | Resmi dokümandan (developer.n11.com) doğrulandı |
| Çiçeksepeti | `apis.ciceksepeti.com/api/v1/orders` (tahmini) | `apis.ciceksepeti.com/api/v1/products/stock-price` (tahmini) | **Doğrulanamadı** — bkz. aşağı |

**Çiçeksepeti notu:** Resmi API dokümantasyonu `ciceksepeti.dev` adresinde mevcut ama site otomatik/bot erişimini engelliyor, bu yüzden tam uç nokta yolunu ve alan adlarını yalnızca dolaylı kaynaklardan (bir topluluk SDK'sının parametre referansından) çıkarabildim. Kodda kullanılan istek şekli mantıklı bir tahmin ama garanti değil. Gerçek `CS_API_KEY` ile ilk denemede "Senkron Günlüğü"nde bir hata görürsen:
1. O hatayı bana ilet, birlikte düzeltiriz — **veya**
2. Kendi hesabınla `https://ciceksepeti.dev` adresine giriş yapıp "Orders" ve "Stok/Fiyat Güncelleme" sayfalarının tam `curl` örneğini kopyalayıp bana gönderirsen, doğrudan doğru uç noktalarla güncellerim.

**Koçtaş** bu sürümde yok — Koçtaş Pazaryeri'nin genel/kendi kendine başvurulabilir bir satıcı API'si bulunmuyor; yalnızca Ticimax, Entegra, Sentos gibi onaylı entegratör yazılımları üzerinden erişilebiliyor. Böyle bir panelin varsa veya Koçtaş'tan doğrudan bir API erişimi alırsan, aynı deseni izleyerek ekleyebiliriz.

## 5. Yeni bir platform eklemek

`server.js` içinde `PLATFORMS` dizisine bakarsan, her platformun `fetchOrders` (sipariş çekme) ve `pushStock` (stok yazma) fonksiyonlarıyla tek bir kayıt olarak tanımlandığını görürsün. Yeni bir pazaryeri eklemek, bu iki fonksiyonu yazıp diziye bir satır eklemek kadar basit — istersen ben yazarım.

## 6. Genel notlar

- Kimlik bilgilerin sadece `.env` dosyanda kalır, hiçbir yere gönderilmez.
- Panel tek kullanıcı için tasarlandı (şifreyle korunuyor). Sürekli açık kalması için bir VPS/sunucuda ya da Render/Railway gibi bir serviste çalıştırman gerekir.
- Trendyol ve N11'in stok güncellemesi asenkron çalışır (bir görev/batch kimliği döner); şu an "gönderildi" olarak kaydediyoruz. Gerçekten işlenip işlenmediğini birkaç dakika sonra kontrol eden ek bir adım istersen ekleyebiliriz.
