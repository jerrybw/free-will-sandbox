import { GameManager } from './game/game';
import { CONFIG_VERSION } from './game/config';
import './styles.css';

const ver = document.getElementById('ver');
if (ver) ver.textContent = `v${CONFIG_VERSION}`;

const game = new GameManager();
game.start();