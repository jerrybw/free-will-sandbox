import { GameManager } from './game/game';
import { CONFIG_VERSION } from './game/config';
import { applyStaticTexts } from './ui/render';
import './styles.css';

// 静态文案注入（页面标题/品牌/导航/面板标题全部来自 ui-texts.json）
applyStaticTexts();

const ver = document.getElementById('ver');
if (ver) ver.textContent = `v${CONFIG_VERSION}`;

const game = new GameManager();
game.start();
