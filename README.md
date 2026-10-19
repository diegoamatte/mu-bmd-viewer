# Visor BMD · MU Online

Visor local de modelos `.bmd` del MU Online y sus texturas (`.ozj`, `.ozt`, `.jpg`, `.tga`, `.png`), para revisar packs de skins antes de meterlos en el cliente.

No usa librerías ni descarga nada: un servidor Node chico que solo lee archivos y una página que dibuja con WebGL2.

## Uso

Necesita [Node.js](https://nodejs.org/).

Doble clic en `abrir-visor.bat` (o `node server.js`). Se abre `http://127.0.0.1:5180/` en el navegador. Cerrá la ventana de la consola para apagarlo.

Con **📁 Elegir carpeta…** elegís la carpeta base de cualquier pack y el visor lista todos sus modelos, incluidas las subcarpetas. Las carpetas usadas quedan en **Recientes**, y al abrir el visor arranca con la última (se guarda en `config.json`, que no se sube al repo).

También se puede pasar la carpeta al arrancar: `node server.js "C:\ruta\al\pack"`, o arrastrarla encima de `abrir-visor.bat`.

## Qué hace

- Lista todos los `.bmd` de la carpeta, agrupados y con buscador (↑ ↓ para recorrerlos).
- Vista 3D con texturas, luz y animaciones (elegís animación, velocidad y frame).
- Cada parte del modelo con su textura: se puede ocultar o cambiar cómo se dibuja (normal, brillo aditivo, transparente).
- Avisa lo que el cliente no va a poder cargar: texturas que faltan o están en otra carpeta, TGA que no son de 32 bits sin comprimir, texturas de más de 1024 px, OZJ mal armados.

## Formatos

La lectura copia lo que hace el cliente [mumain](https://github.com/sven-n/MuMain):

- **BMD** v10 (sin encriptar) y v12 (encriptado con `MapFileDecrypt`). La v14 (LEA) no está soportada.
- **OZJ**: JPEG con 24 bytes de cabecera. **OZT**: TGA con 4 bytes de cabecera.
- Las texturas se rellenan a potencia de 2 igual que en el cliente, así los UV se ven igual que en el juego.
- Las texturas terminadas en `_R` se dibujan con brillo aditivo (convención del MU para efectos).

## Controles

| Acción | Cómo |
|---|---|
| Rotar | arrastrar |
| Mover | clic derecho o Shift + arrastrar |
| Zoom | rueda |
| Centrar | doble clic |
