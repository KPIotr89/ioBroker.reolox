# ioBroker.reolink-loxone — Status projektu

## Wersja: 1.3.0
## Repo: https://github.com/KPIotr89/ioBroker.reolink-loxone
## Serwer ioBroker: 192.168.0.201:8081

---

## Infrastruktura

| Serwis | Adres | Uwagi |
|--------|-------|-------|
| ioBroker | 192.168.0.201:8081 | LXC kontener #102 na Proxmox |
| Proxmox | 192.168.0.200 | host hypervisora |
| go2rtc | 192.168.0.201:1984 | zainstalowany jako systemd service |
| Loxone Miniserver | sieć lokalna | Remote Connect (Cloud) |

## Kamery

| Nazwa | IP | Model | Uwagi |
|-------|-----|-------|-------|
| front | 192.168.0.48 | Reolink (RLC-810A / CX810?) | ONVIF PullPoint NIE działa |
| taras | 192.168.0.49 | CX810, FW v3.1.0.5129 | ONVIF PullPoint NIE działa |
| garaz | 192.168.0.61 | Reolink Video Doorbell PoE, FW v3.0.0.4662 | Doorbell — GetDoorbell nie działa, push webhook działa |

**Użytkownik kamer w API:** `loxone` / `loxone123`

---

## Architektura adaptera

### Pliki
```
main.js                  # główny adapter
lib/
  reolink-api.js         # wrapper HTTP API Reolink
  loxone-bridge.js       # wysyłanie zdarzeń do Loxone (HTTP VI / UDP)
  discovery.js           # ONVIF WS-Discovery (auto-wykrywanie kamer)
admin/
  jsonConfig.json        # konfiguracja UI adaptera
```

### Mechanizmy wykrywania zdarzeń
| Zdarzenie | Mechanizm | Uwagi |
|-----------|-----------|-------|
| Motion | Polling co 5s (GetMdState) | |
| AI (person/vehicle/animal) | Polling co 5s (GetAiState) | tylko kamery z AI |
| WhiteLed / gate trigger | Polling co 1s (GetWhiteLed) | tylko kamery z flagą whiteLedGateTrigger |
| Visitor / doorbell | Webhook push z kamery | kamera POSTuje na port 7777 |

### Gate trigger (WhiteLed knock-pattern)
- Kamera "front" ma włączoną opcję `whiteLedGateTrigger`
- Jeśli WhiteLed włączone ≤ 3s i wyłączone → adapter wysyła `gate_trigger=1` do Loxone
- Fast poll 1s zamiast 5s dla tych kamer
- Mutex `pollingActive` chroni przed nakładaniem się cykli

### Webhook server
- Port: **7777**
- URL kamery: `http://192.168.0.201:7777/reolink/{nazwaKamery}`
- Weryfikuje body — tylko znane typy zdarzeń są obsługiwane
- Kamera "garaz" ma skonfigurowany push URL (Node-RED zastąpiony)

### Loxone Virtual Inputs
```
Reolink_{CameraName}_Motion
Reolink_{CameraName}_AI_person
Reolink_{CameraName}_AI_vehicle
Reolink_{CameraName}_AI_animal
Reolink_{CameraName}_Online
Reolink_{CameraName}_Visitor
Reolink_{CameraName}_gate_trigger
Reolink_{CameraName}_Intercom     ← RTSP URL (go2rtc) gdy dzwonek naciśnięty
```

### go2rtc integracja
- go2rtc config: `/etc/go2rtc/go2rtc.yaml`
- Streamy: `front`, `taras`, `garaz` → main stream RTSP
- W konfiguracji adaptera (zakładka Webhook): `go2rtcUrl = rtsp://192.168.0.201:8554`
- Gdy visitor event → Loxone dostaje `rtsp://192.168.0.201:8554/{camId}`

### Loxone Intercom — podgląd kamery
- **Snapshot URL** (działa zawsze, ~2fps):
  ```
  http://loxone:loxone123@192.168.0.48:80/cgi-bin/api.cgi?cmd=Snap&channel=0&user=loxone&password=loxone123
  ```
- **MJPEG przez go2rtc** (wymaga transkodowania, obciąża CPU):
  ```
  http://192.168.0.201:1984/api/stream.mjpeg?src=front
  ```
- **RTSP przez go2rtc** (płynny, ale Loxone Intercom nie obsługuje RTSP):
  ```
  rtsp://192.168.0.201:8554/front
  ```
- Zdalne połączenie (Loxone Cloud Remote Connect): wymaga VPN lub port forwarding portu 1984

---

## Znane ograniczenia

| Problem | Przyczyna | Status |
|---------|-----------|--------|
| ONVIF PullPoint nie działa | Firmware Reolink v3.x zwraca SOAP-ENV:Client | Usunięte z adaptera |
| GetDoorbell nie działa na "garaz" | Firmware v3.0.0.4662 nie obsługuje tej komendy | Wykrywane i omijane — webhook działa |
| MJPEG nie płynny | Transkodowanie H264→MJPEG bez GPU | Akceptowalny snapshot jako alternatywa |
| Zdalne wideo poza VPN | Loxone Cloud nie proxy'uje URL kamery | Wymaga VPN lub port forwarding |
| AI=false na wszystkich kamerach | CX810/Doorbell PoE nie mają AI w tej wersji firmware | Brak rozwiązania |

---

## Propozycje dalszego rozwoju

### Priorytet wysoki
1. **Snapshot URL w stanie ioBroker** — dodać `streams.snapshotUrl` per kamera, żeby URL był dostępny bez wpisywania ręcznie
2. **go2rtc auto-konfiguracja** — adapter przy starcie automatycznie zapisuje/aktualizuje `go2rtc.yaml` na podstawie listy kamer, bez ręcznej edycji pliku
3. **Wersjonowanie pakietu** — bump wersji do 1.4.0 i changelog

### Priorytet średni
4. **Multi-channel NVR** — lepsze wsparcie dla NVR (RLN8/RLN16), każdy kanał jako osobna kamera z automatycznym wykryciem liczby kanałów
5. **Token refresh** — automatyczne odnawianie tokenu logowania przed wygaśnięciem (teraz lease 3600s)
6. **Retry logika** — przy utracie połączenia z kamerą exponential backoff zamiast stałego interwału
7. **Loxone HTTP feedback** — odbieranie potwierdzenia z Loxone że VI zostało przyjęte

### Priorytet niski
8. **Historia zdarzeń** — ostatnie N zdarzeń per kamera jako stan ioBroker (JSON array)
9. **Statystyki** — licznik motion eventów per kamera per dzień
10. **Panel diagnostyczny** — zakładka w adminie pokazująca status połączenia z każdą kamerą i go2rtc

---

## Komendy serwisowe

```bash
# Aktualizacja adaptera
iobroker url https://github.com/KPIotr89/ioBroker.reolink-loxone

# Status go2rtc
systemctl status go2rtc

# Logi go2rtc
journalctl -u go2rtc -f

# Restart go2rtc
systemctl restart go2rtc

# Edycja konfiguracji go2rtc
nano /etc/go2rtc/go2rtc.yaml
```
