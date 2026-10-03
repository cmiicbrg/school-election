# Third-party notices

The container image contains the npm packages that `package-lock.json` lists for production. They are under permissive licenses, except one native library, which the first notice is about; the web app's built files carry two fonts under a font license, which the second is about. The image carries this directory as `/app/third-party-notices`.

## libvips

The API re-encodes candidate pictures with [sharp](https://sharp.pixelplumbing.com) (Apache-2.0), which loads [libvips](https://www.libvips.org) as a shared library at run time. The library comes from the npm package `@img/sharp-libvips-linux-x64` 1.3.4 and is the file `/app/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7` in the image. Nothing of it is linked statically into the application or bundled into another file.

libvips 8.18.7 is licensed under the GNU Lesser General Public License, version 3 or later: [LGPL-3.0.txt](LGPL-3.0.txt), which supplements the GNU General Public License, version 3: [GPL-3.0.txt](GPL-3.0.txt).

- Source of libvips 8.18.7: <https://github.com/libvips/libvips/tree/v8.18.7>
- The shared library is built by <https://github.com/lovell/sharp-libvips/tree/v1.3.4>, whose build scripts name the exact source of libvips and of every library it contains.

The shared library contains these libraries, under the licenses the package lists for them. Libraries under the LGPLv3 are used under it through the "any later version" clause of the LGPLv2 or LGPLv2.1.

| Library | Version | License |
| --- | --- | --- |
| aom | 3.15.1 | BSD 2-Clause and the Alliance for Open Media Patent License 1.0 |
| cairo | 1.18.6 | Mozilla Public License 1.1 ([MPL-1.1.txt](MPL-1.1.txt)) |
| cgif | 0.5.4 | MIT |
| expat | 2.8.5 | MIT |
| fontconfig | 2.18.3 | fontconfig License (BSD-like) |
| freetype | 2.14.3 | FreeType License (BSD-like) |
| fribidi | 1.0.17 | LGPLv3 |
| glib | 2.90.0 | LGPLv3 |
| harfbuzz | 14.5.0 | MIT |
| highway | 1.4.0 | BSD 3-Clause |
| lcms | 2.19.1 | MIT |
| libarchive | 3.8.9 | BSD 2-Clause |
| libexif | 0.6.26 | LGPLv3 |
| libffi | 3.8.0 | MIT |
| libheif | 1.23.5 | LGPLv3 |
| libimagequant | 2.4.1 | BSD 2-Clause |
| libpng | 1.6.58 | libpng License |
| librsvg | 2.63.2 | LGPLv3 |
| libtiff | 4.7.2 | libtiff License (BSD-like) |
| libultrahdr | 2.0.2 | MIT |
| libvips | 8.18.7 | LGPLv3 |
| libwebp | 1.6.0 | BSD 3-Clause |
| libxml2 | 2.15.4 | MIT |
| mozjpeg | 0826579 | zlib License, IJG License, BSD 3-Clause |
| pango | 1.58.2 | LGPLv3 |
| pixman | 0.46.4 | MIT |
| proxy-libintl | 0.5 | LGPLv3 |
| zlib-ng | 2.3.3 | zlib License |

### Replacing the library

sharp loads the shared library from the file named above when the API starts. To run the image with a modified libvips, build a compatible shared library, for example with the sharp-libvips build scripts at the version above, and put it in place of that file, in a derived image or through a volume mount. A test of this repository (`apps/api/test/third-party-notices.test.ts`) keeps the versions in this notice equal to the ones installed.

## Fonts

The printable sheets of the web app use two fonts, which Vite bundles into the app's static files from the npm packages `@fontsource/dm-sans` 5.3.0 and `@fontsource/jetbrains-mono` 5.3.0 (the packages are MIT; the fonts are not): [DM Sans](https://github.com/googlefonts/dm-fonts) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both under the SIL Open Font License, version 1.1, whose text each font carries with its copyright and reserved font name: [OFL-1.1-DM-Sans.txt](OFL-1.1-DM-Sans.txt) and [OFL-1.1-JetBrains-Mono.txt](OFL-1.1-JetBrains-Mono.txt). The font files are served as the packages ship them; nothing of them is modified, and the fonts are not sold by themselves.
