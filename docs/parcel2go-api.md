# Parcel2Go API – Getting Parcel Quotes (End to End)

> **In this app** (added 2026-11-06): the quote client is `src/postage.ts`, and `scripts/parcel2go-quote.mjs` checks real replies. The variables are named `PARCEL2GO_CLIENT_ID`, `PARCEL2GO_CLIENT_SECRET` and `PARCEL2GO_SANDBOX=true` (not the `P2G_*` names in the examples below), kept in `.dev.vars` for Sandbox and `.prod.vars` for production, both gitignored, and uploaded to Key Vault with `scripts/azure-secrets.mjs`. The examples in other languages below are kept as reference only.

This guide covers everything needed to go from a Parcel2Go **client ID + secret** to a list of priced courier quotes in your application.

> **Sources.** Request/response shapes come from the Parcel2Go Swagger docs (`/api/swagger/ui/index`, *Quotes → POST /quotes*). Where a field's meaning isn't stated in the docs, this guide says so and marks it **(inferred)** – check those against a real sandbox response.

---

## Contents

1. [How it works](#1-how-it-works)
2. [Environments and credentials](#2-environments-and-credentials)
3. [Step 1 – Get an access token](#3-step-1--get-an-access-token)
4. [Step 2 – Request quotes](#4-step-2--request-quotes)
5. [Step 3 – Read the response](#5-step-3--read-the-response)
6. [Errors](#6-errors)
7. [Full example code](#7-full-example-code)
8. [Testing checklist](#8-testing-checklist)
9. [After quoting – what comes next](#9-after-quoting--what-comes-next)

---

## 1. How it works

There is **no permanent API key**. Parcel2Go uses OAuth2 *client credentials*:

```
┌──────────────┐  1. client_id + client_secret   ┌──────────────────────────┐
│              │ ──────────────────────────────▶ │ POST /auth/connect/token │
│  Your app    │ ◀────────────────────────────── │                          │
│  (backend)   │     access_token (2 hours)      └──────────────────────────┘
│              │
│              │  2. Bearer token + parcel data  ┌──────────────────────────┐
│              │ ──────────────────────────────▶ │ POST /api/quotes         │
│              │ ◀────────────────────────────── │                          │
└──────────────┘     { "Quotes": [ ... ] }       └──────────────────────────┘
```

1. Your app swaps the ID and secret for a short-lived **access token**.
2. It sends that token in the `Authorization` header of each quote request.
3. When the token expires (after ~2 hours), it gets a new one.

Parcel2Go says quoting should always come **before** creating an order: the quote endpoint does a **live acceptance check** for your parcel. The services endpoint only lists services they offer, so skipping the quote gives no guarantee your parcel will be accepted.

---

## 2. Environments and credentials

| Environment | Base URL | Use for |
|---|---|---|
| Sandbox | `https://sandbox.parcel2go.com` | Development and testing |
| Live | `https://www.parcel2go.com` | Real prices and bookings |

- Sandbox and live credentials are normally **separate** – a sandbox ID/secret won't work on live.
- Keep the secret **server-side only**. Never put it in front-end JavaScript, a mobile app bundle, or a git repo.
- Store credentials as environment variables (or a secrets manager), e.g.:

```bash
export P2G_BASE_URL=https://sandbox.parcel2go.com
export P2G_CLIENT_ID=your-client-id
export P2G_CLIENT_SECRET=your-client-secret
```

---

## 3. Step 1 – Get an access token

### Request

```http
POST /auth/connect/token HTTP/1.1
Host: sandbox.parcel2go.com
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=client_credentials&scope=public-api&client_id=<client_id>&client_secret=<client_secret>
```

⚠️ The body is **form-encoded** (`key=value&key=value`), **not JSON**. Sending JSON here is the most common reason this call fails.

| Field | Value | Notes |
|---|---|---|
| `grant_type` | `client_credentials` | Always this value |
| `scope` | space-separated list | See scopes below. URL-encode the space as `%20` (most HTTP libraries do this for you) |
| `client_id` | your client ID | |
| `client_secret` | your client secret | |

**Scopes**

| Scope | Grants |
|---|---|
| `public-api` | Basic access – **required for every call, and enough for quotes** |
| `payment` | Making payments (needed later for booking) |
| `my-profile` | The `Me` endpoints (your account info) |

Ask only for what you need. For quoting: `scope=public-api`.

### Response

```json
{
  "access_token": "435435435345SDFS...",
  "expires_in": 7200,
  "token_type": "Bearer"
}
```

| Field | Meaning |
|---|---|
| `access_token` | Send this in the `Authorization` header |
| `expires_in` | Lifetime in **seconds** (7200 = 2 hours) |
| `token_type` | Always `Bearer` |

### Token handling – do this properly

- **Cache** the token. Don't request a new one for every quote.
- Record `expiry = now + expires_in` and **refresh a minute or so early** so a request never goes out with a token that's just expired.
- If a request comes back **401 Unauthorized**, request a fresh token and retry once.

### Quick test with curl

```bash
curl -X POST "$P2G_BASE_URL/auth/connect/token" \
  -H "Accept: application/json" \
  -d grant_type=client_credentials \
  -d scope=public-api \
  -d client_id="$P2G_CLIENT_ID" \
  -d client_secret="$P2G_CLIENT_SECRET"
```

(`curl -d` sends form-encoded data by default.)

---

## 4. Step 2 – Request quotes

### Request

```http
POST /api/quotes HTTP/1.1
Host: sandbox.parcel2go.com
Content-Type: application/json
Accept: application/json
Authorization: Bearer <access_token>
```

### Minimal body

Only the countries and the parcels are needed for a rough quote:

```json
{
  "CollectionAddress": { "Country": "GBR" },
  "DeliveryAddress":   { "Country": "GBR" },
  "Parcels": [
    { "Value": 150, "Weight": 2, "Length": 9, "Width": 8, "Height": 10 }
  ]
}
```

### Full body (all fields from Swagger)

```json
{
  "CollectionAddress": {
    "Country": "GBR",
    "Property": "123",
    "Postcode": "AA1 1AA",
    "Town": "Example",
    "VatStatus": "Individual"
  },
  "DeliveryAddress": {
    "Country": "GBR",
    "Property": "123",
    "Postcode": "AA1 1AA",
    "Town": "Example",
    "VatStatus": "Individual"
  },
  "Parcels": [
    { "Value": 4.99, "Weight": 0.6, "Length": 50, "Width": 40, "Height": 50 }
  ],
  "Extras": [
    { "Type": "ExtendedBaseCover", "Values": { "ExampleKey": "ExampleValue" } }
  ],
  "IncludedDropShopDistances": false,
  "ServiceFilter": {
    "IncludeServiceTags": [],
    "ExcludeServiceTags": []
  },
  "ExportReason": "Sale"
}
```

### Field reference

**Addresses** (`CollectionAddress` = where it's sent from, `DeliveryAddress` = where it's going)

| Field | Type | Required | Notes |
|---|---|---|---|
| `Country` | string | **Yes** | 3-letter ISO code: `GBR`, `FRA`, `DEU`, `USA`, … |
| `Postcode` | string | Recommended | Gives more accurate prices and availability (e.g. Highlands, islands and Northern Ireland are often priced differently) |
| `Town` | string | Optional | |
| `Property` | string | Optional | House name or number |
| `VatStatus` | string | Optional | Example value is `Individual`; presumably also a business value **(inferred)** – affects VAT on international shipments |

**Parcels** – an array, one object per box. Send several to quote a multi-parcel shipment.

| Field | Type | Unit | Notes |
|---|---|---|---|
| `Weight` | number | **kg** | Actual weight. Couriers may charge on *volumetric* weight if the box is large and light |
| `Length` | number | **cm** | |
| `Width` | number | **cm** | |
| `Height` | number | **cm** | |
| `Value` | number | **£ (GBP)** | Declared value of the contents – used for cover/insurance and customs |

**Optional extras**

| Field | Type | Notes |
|---|---|---|
| `Extras` | array | Add-ons to price into the quote, e.g. `{ "Type": "ExtendedBaseCover", ... }`. The `Values` object holds type-specific settings – check the Swagger *Model* tab for which keys each type takes |
| `IncludedDropShopDistances` | bool | Likely returns distance to the nearest drop-off shop for shop-collection services (see `Distance` in the response) **(inferred)** |
| `ServiceFilter.IncludeServiceTags` | string[] | Only return services with these tags |
| `ServiceFilter.ExcludeServiceTags` | string[] | Hide services with these tags. Tags are listed on each quote's `Service.Tags` |
| `ExportReason` | string | International only – e.g. `Sale`. Needed for customs |

### Content types

From the Swagger UI:

- **Request** (`Parameter content type`): `application/json`
- **Response** (`Response Content Type`): `application/json`, `text/json`, `application/xml` or `text/xml` – chosen with your `Accept` header.

Use `Accept: application/json` unless you specifically want XML.

---

## 5. Step 3 – Read the response

### Shape

```json
{
  "Quotes": [
    { ...one quote per courier service... }
  ]
}
```

Each item in `Quotes` is **one courier service** that can take your parcel, with its price. A typical UK quote returns dozens. They are **not guaranteed to be sorted** – sort them yourself (e.g. by `TotalPrice`).

### Example quote (from Swagger)

```json
{
  "AvailableExtras": [
    { "Type": "DeliveryGuarantee", "Price": 1.5, "Vat": 0.2, "Total": 1.8 }
  ],
  "Discount": 0,
  "Extras": [
    { "Amount": 1, "Type": "ExtendedBaseCover" }
  ],
  "Service": {
    "CourierName": "Example",
    "CourierSlug": "example",
    "Slug": "24h-example",
    "Name": "Example 24H",
    "CollectionType": "Shop",
    "DeliveryType": "Door",
    "Links": {
      "ImageSmall": "https://example.com/logo/service/10410.small",
      "Imagelarge": "https://example.com/logo/service/10410.large",
      "ImageSvg": "https://example.com/logo/service/24h-example/logo.normal-svg",
      "Courier": "https://example.com/couriers/example",
      "Service": "https://example.com/service/24h-example"
    },
    "MaxHeight": 10,
    "MaxWidth": 10,
    "MaxLength": 10,
    "MaxWeight": 1.55,
    "MaxCover": 2500,
    "IsPrinterRequired": false,
    "ShortDescriptions": "Example short description",
    "Overview": "<p>Example overview</p>",
    "Features": "<p>Example features</p>",
    "RequiresDimensions": true,
    "Tags": ["EXAMPLE"],
    "Classification": "Slow"
  },
  "TotalPrice": 12.66,
  "TotalPriceExVat": 10.55,
  "TotalVat": 2.11,
  "UnitPrice": 9.55,
  "VatRate": 0.2,
  "Collection": "2026-11-07T02:00:30.6993882Z",
  "CutOff": "2026-11-06T06:00:30.6993882Z",
  "EstimatedDeliveryDate": "2026-11-08T02:00:30.6993882Z",
  "IncludedCover": 2.5,
  "ProtectedValue": 5.5,
  "TariffSystem": "HS",
  "TariffCodeRequired": true,
  "CountryOfManufactureRequired": false,
  "ExportReasonRequired": false,
  "Distance": 1.5,
  "RequiresCommercialInvoice": false,
  "RequiresCustoms": false,
  "RecipientTaxIdRequirements": { "...": "..." },
  "SenderEoriRequirements": { "...": "..." },
  "IossRequirements": { "...": "..." },
  "RecipientEoriRequirements": { "...": "..." },
  "ItemSkuRequirements": { "...": "..." },
  "ManufacturerIdRequirements": { "...": "..." },
  "CurrencyCode": "GBP"
}
```

### Field reference

#### Price – what you'll show most

| Field | Meaning |
|---|---|
| `TotalPrice` | **What the customer pays, incl. VAT.** Use this as the headline price |
| `TotalPriceExVat` | Total before VAT |
| `TotalVat` | VAT amount |
| `VatRate` | VAT rate as a fraction (`0.2` = 20%) |
| `UnitPrice` | Base price of the service before extras **(inferred)** – note in the example `UnitPrice + extras ≈ TotalPriceExVat` |
| `Discount` | Discount applied, in currency |
| `CurrencyCode` | Currency of all prices, e.g. `GBP` |

#### Service – which courier and what kind

| Field | Meaning |
|---|---|
| `Service.Name` | Display name, e.g. "Example 24H" |
| `Service.CourierName` / `CourierSlug` | Courier brand (e.g. DPD, Evri) |
| `Service.Slug` | **Unique service ID – keep this.** You'll need it to book the service later |
| `Service.CollectionType` | How the parcel leaves you: e.g. `Shop` (drop off) – other values likely include collection from your door **(inferred)** |
| `Service.DeliveryType` | How it arrives: e.g. `Door` – other values likely include shop/locker pickup **(inferred)** |
| `Service.Classification` | Speed band, e.g. `Slow` |
| `Service.Tags` | Tags you can filter on with `ServiceFilter` |
| `Service.IsPrinterRequired` | `true` if the sender must print a label |
| `Service.RequiresDimensions` | `true` if dimensions are mandatory for this service |
| `Service.MaxLength/Width/Height` | Size limits (cm) **(units inferred)** |
| `Service.MaxWeight` | Weight limit (kg) **(units inferred)** |
| `Service.MaxCover` | Maximum cover you can buy (£) |
| `Service.ShortDescriptions` | One-line description (plain text) |
| `Service.Overview`, `Service.Features` | **HTML** – sanitise before inserting into your own pages |
| `Service.Links.*` | Courier/service logos (`ImageSmall`, `Imagelarge` – note the lower-case *l*, `ImageSvg`) and info pages |

#### Timing

All are **ISO 8601 UTC** timestamps (`...Z`). Convert to UK time before showing them.

| Field | Meaning |
|---|---|
| `Collection` | When the parcel will be collected / should be dropped off **(inferred)** |
| `CutOff` | Latest time to book to make that collection **(inferred)** |
| `EstimatedDeliveryDate` | Expected delivery date – an estimate, not a guarantee |

#### Cover and extras

| Field | Meaning |
|---|---|
| `IncludedCover` | Cover included free with the service (£) |
| `ProtectedValue` | Value currently protected for this quote (£) **(inferred)** |
| `Extras` | Extras already included in this quote's price, e.g. `ExtendedBaseCover` |
| `AvailableExtras` | Add-ons you *could* buy, each with `Type`, `Price` (ex VAT), `Vat` (rate) and `Total` (inc VAT). E.g. `DeliveryGuarantee` |
| `Distance` | Distance to drop-off point, when `IncludedDropShopDistances` is `true` **(inferred)** |

#### International / customs (ignore for UK → UK)

| Field | Meaning |
|---|---|
| `RequiresCustoms` | Customs paperwork needed |
| `RequiresCommercialInvoice` | Commercial invoice needed |
| `TariffSystem`, `TariffCodeRequired` | Whether an HS tariff code must be supplied for each item |
| `CountryOfManufactureRequired` | Must state country of manufacture |
| `ExportReasonRequired` | Must supply `ExportReason` |
| `*Requirements` objects | `RecipientTaxId`, `SenderEori`, `RecipientEori`, `Ioss`, `ItemSku`, `ManufacturerId`. Each has `IsRequired`, a `Validation` regex and sometimes `MaxLength`, `Label`, `Helper` – use them to build and validate booking forms |

### Turning the response into something useful

A typical pipeline:

1. **Filter** – drop services that don't suit you (e.g. `IsPrinterRequired` if the sender has no printer, or a `CollectionType` you don't want).
2. **Sort** by `TotalPrice` (cheapest) or `EstimatedDeliveryDate` (fastest).
3. **Display** `Service.Name`, `Service.CourierName`, `TotalPrice`, `EstimatedDeliveryDate`, and the logo from `Service.Links.ImageSmall`.
4. **Store** the chosen `Service.Slug` and the quote details for booking.

---

## 6. Errors

| Status | When | Body / fix |
|---|---|---|
| `400 Bad Request` | Invalid body – missing country, wrong types, bad JSON | `{ "Message": "The request is invalid." }` – check field names (they are **PascalCase**) and numeric types |
| `401 Unauthorized` | Missing, wrong or expired token | Get a new token and retry once |
| `403 Forbidden` | Token lacks the needed scope **(typical OAuth behaviour)** | Add the scope when requesting the token |
| `5xx` | Parcel2Go-side problem | Retry with backoff; show a friendly error |

Token endpoint failures usually mean: body sent as JSON instead of form-encoded, sandbox credentials used on live (or vice versa), or a typo in the secret.

An **empty `Quotes` array** isn't an error – it means no service will take that parcel (too big, too heavy, unsupported route).

---

## 7. Full example code

### Python

`pip install requests`

```python
import os, time, requests

BASE_URL = os.environ.get("P2G_BASE_URL", "https://sandbox.parcel2go.com")
CLIENT_ID = os.environ["P2G_CLIENT_ID"]
CLIENT_SECRET = os.environ["P2G_CLIENT_SECRET"]

_token, _expiry = None, 0.0

def get_token(force=False):
    global _token, _expiry
    if not force and _token and time.time() < _expiry - 60:
        return _token
    r = requests.post(
        f"{BASE_URL}/auth/connect/token",
        data={  # form-encoded
            "grant_type": "client_credentials",
            "scope": "public-api",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
        },
        headers={"Accept": "application/json"},
        timeout=15,
    )
    r.raise_for_status()
    body = r.json()
    _token, _expiry = body["access_token"], time.time() + body["expires_in"]
    return _token

def get_quotes(parcels, from_country="GBR", to_country="GBR",
               from_postcode=None, to_postcode=None):
    def address(country, postcode):
        return {"Country": country, **({"Postcode": postcode} if postcode else {})}

    payload = {
        "CollectionAddress": address(from_country, from_postcode),
        "DeliveryAddress": address(to_country, to_postcode),
        "Parcels": parcels,
    }
    for attempt in range(2):
        r = requests.post(
            f"{BASE_URL}/api/quotes",
            json=payload,
            headers={"Authorization": f"Bearer {get_token(force=attempt > 0)}",
                     "Accept": "application/json"},
            timeout=30,
        )
        if r.status_code != 401:
            break
    if r.status_code == 400:
        raise ValueError(r.json().get("Message", r.text))
    r.raise_for_status()
    return r.json()["Quotes"]

if __name__ == "__main__":
    quotes = get_quotes(
        parcels=[{"Value": 150, "Weight": 2, "Length": 9, "Width": 8, "Height": 10}],
    )
    quotes.sort(key=lambda q: q["TotalPrice"])
    for q in quotes[:10]:
        s = q["Service"]
        print(f'{s["CourierName"]:<15} {s["Name"]:<35} '
              f'£{q["TotalPrice"]:>6.2f}  est. {q["EstimatedDeliveryDate"][:10]}  '
              f'[{s["Slug"]}]')
```

### C# (.NET 8)

```csharp
using System.Net.Http.Headers;
using System.Net.Http.Json;

public record TokenResponse(string access_token, int expires_in, string token_type);

public record Address(string Country, string? Postcode = null, string? Town = null,
                      string? Property = null, string? VatStatus = null);
public record Parcel(decimal Value, decimal Weight, decimal Length, decimal Width, decimal Height);
public record QuoteRequest(Address CollectionAddress, Address DeliveryAddress, List<Parcel> Parcels);

public record ServiceInfo(string Name, string CourierName, string Slug,
                          string CollectionType, string DeliveryType, bool IsPrinterRequired);
public record Quote(ServiceInfo Service, decimal TotalPrice, decimal TotalPriceExVat,
                    decimal TotalVat, DateTime EstimatedDeliveryDate, string CurrencyCode);
public record QuoteResponse(List<Quote> Quotes);

public class Parcel2GoClient(HttpClient http, string clientId, string clientSecret)
{
    private string? _token;
    private DateTime _expiry;

    private async Task<string> GetTokenAsync(bool force = false)
    {
        if (!force && _token != null && DateTime.UtcNow < _expiry.AddMinutes(-1)) return _token;

        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "client_credentials",
            ["scope"] = "public-api",
            ["client_id"] = clientId,
            ["client_secret"] = clientSecret,
        });
        var res = await http.PostAsync("/auth/connect/token", form);
        res.EnsureSuccessStatusCode();
        var t = (await res.Content.ReadFromJsonAsync<TokenResponse>())!;
        _token = t.access_token;
        _expiry = DateTime.UtcNow.AddSeconds(t.expires_in);
        return _token;
    }

    public async Task<List<Quote>> GetQuotesAsync(QuoteRequest request)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var msg = new HttpRequestMessage(HttpMethod.Post, "/api/quotes")
            {
                Content = JsonContent.Create(request)
            };
            msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetTokenAsync(attempt > 0));
            var res = await http.SendAsync(msg);
            if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized) continue;
            res.EnsureSuccessStatusCode();
            return (await res.Content.ReadFromJsonAsync<QuoteResponse>())!.Quotes;
        }
        throw new UnauthorizedAccessException("Parcel2Go rejected the token twice.");
    }
}

// Usage
// var http = new HttpClient { BaseAddress = new Uri("https://sandbox.parcel2go.com") };
// var client = new Parcel2GoClient(http, Environment.GetEnvironmentVariable("P2G_CLIENT_ID")!,
//                                        Environment.GetEnvironmentVariable("P2G_CLIENT_SECRET")!);
// var quotes = await client.GetQuotesAsync(new QuoteRequest(
//     new Address("GBR"), new Address("GBR"),
//     [new Parcel(150, 2, 9, 8, 10)]));
// foreach (var q in quotes.OrderBy(q => q.TotalPrice).Take(10))
//     Console.WriteLine($"{q.Service.CourierName} {q.Service.Name} £{q.TotalPrice}");
```

`System.Text.Json` (which `ReadFromJsonAsync` uses) matches property names case-insensitively, so the PascalCase response maps straight onto these records. `JsonContent.Create` keeps PascalCase names on the request. Only the fields you declare are read – add more to the records as you need them.

---

## 8. Testing checklist

- [ ] Token request returns `access_token` on sandbox
- [ ] Quote request with the minimal body returns a non-empty `Quotes` array
- [ ] Save one raw response to a file and compare its fields with this guide (especially those marked **inferred**)
- [ ] Postcodes added → prices change sensibly for e.g. a Highlands postcode
- [ ] Oversized/overweight parcel → fewer or no quotes, no crash
- [ ] Bad body (e.g. no `Country`) → `400` handled with a clear message
- [ ] Expired/invalid token → app refreshes and retries once
- [ ] Token reused across multiple quotes (not one token per request)
- [ ] Secret not in source control or client-side code
- [ ] Switch `P2G_BASE_URL` and credentials to live only when ready

---

## 9. After quoting – what comes next

Quoting is the first step of booking. The general flow is:

1. **Quote** (this guide) → user picks a quote; keep its `Service.Slug` and the parcel/address details.
2. **Create an order** using that service slug plus full sender/recipient addresses and contents (and customs details if `RequiresCustoms` is true).
3. **Pay** – needs a token with the `payment` scope.
4. **Get labels and tracking** for the booked order.

Check the *Orders* and *Payment* sections of the Swagger docs for the exact request formats for steps 2–4.