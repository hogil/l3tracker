/**
 * 컨텍스트 메뉴 관련 기능들
 * 우클릭 메뉴, 파일 다운로드, 이미지 합성, 클립보드 복사
 */

import { calculateGridSize, copyToClipboard, extractFolderName, extractFileName, splitFileName } from './utils.js';

/**
 * 컨텍스트 메뉴 관리 클래스
 */
export class ContextMenuManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.menu = null;
        this.isVisible = false;
        
        this.initializeMenu();
        this.bindEvents();
    }
    
    /**
     * 컨텍스트 메뉴 초기화
     */
    initializeMenu() {
        this.menu = document.getElementById('grid-context-menu');
        if (!this.menu) {
            console.warn('컨텍스트 메뉴 요소를 찾을 수 없습니다.');
            return;
        }
        
        // 메뉴 항목들에 이벤트 리스너 연결
        const downloadItem = document.getElementById('context-download');
        const mergeCopyItem = document.getElementById('context-merge-copy');
        const listCopyItem = document.getElementById('context-list-copy');
        const tableCopyItem = document.getElementById('context-table-copy');
        const cancelItem = document.getElementById('context-cancel');
        
        if (downloadItem) {
            downloadItem.onclick = () => {
                this.hide();
                this.downloadSelectedImages();
            };
        }
        
        if (mergeCopyItem) {
            mergeCopyItem.onclick = () => {
                this.hide();
                this.mergeAndCopyImages();
            };
        }
        
        if (listCopyItem) {
            listCopyItem.onclick = () => {
                this.hide();
                this.copyFileList();
            };
        }
        
        if (tableCopyItem) {
            tableCopyItem.onclick = () => {
                this.hide();
                this.copyFileListAsTable();
            };
        }
        
        if (cancelItem) {
            cancelItem.onclick = () => {
                this.hide();
            };
        }
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        // 전역 클릭으로 메뉴 숨기기
        this.globalClickHandler = (e) => {
            if (this.isVisible && !this.menu.contains(e.target)) {
                this.hide();
            }
        };
    }
    
    /**
     * 컨텍스트 메뉴 표시
     * @param {MouseEvent} event 마우스 이벤트
     * @param {number} clickedIdx 클릭된 이미지 인덱스
     */
    show(event, clickedIdx) {
        event.preventDefault();
        
        // 클릭된 이미지가 선택되지 않았으면 해당 이미지만 선택
        if (!this.viewer.gridSelectedIdxs.includes(clickedIdx)) {
            this.viewer.gridSelectedIdxs = [clickedIdx];
            this.viewer.updateGridSelection();
        }
        
        // 메뉴 위치 설정
        this.menu.style.left = event.pageX + 'px';
        this.menu.style.top = event.pageY + 'px';
        this.menu.style.display = 'block';
        
        this.isVisible = true;
        
        // 전역 클릭 리스너 추가
        document.addEventListener('click', this.globalClickHandler);
    }
    
    /**
     * 컨텍스트 메뉴 숨기기
     */
    hide() {
        if (this.menu) {
            this.menu.style.display = 'none';
        }
        this.isVisible = false;
        
        // 전역 클릭 리스너 제거
        document.removeEventListener('click', this.globalClickHandler);
    }
    
    /**
     * 선택된 이미지들 다운로드
     */
    async downloadSelectedImages() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('다운로드할 이미지를 선택해주세요.');
            return;
        }
        
        console.log(`${selectedFiles.length}개 파일 다운로드 시작`);
        
        for (let i = 0; i < selectedFiles.length; i++) {
            const filePath = selectedFiles[i];
            await this.downloadImage(filePath);
            
            // 브라우저의 다운로드 제한을 피하기 위해 짧은 지연
            if (i < selectedFiles.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log('모든 파일 다운로드 완료');
    }
    
    /**
     * 단일 이미지 다운로드
     * @param {string} filePath 파일 경로
     */
    async downloadImage(filePath) {
        try {
            const response = await fetch(`/api/image?path=${encodeURIComponent(filePath)}`);
            if (!response.ok) {
                throw new Error(`다운로드 실패: ${response.status}`);
            }
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = filePath.split('/').pop();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error('이미지 다운로드 오류:', error);
        }
    }
    
    /**
     * 선택된 이미지들을 합쳐서 클립보드에 복사
     */
    async mergeAndCopyImages() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('합칠 이미지를 선택해주세요.');
            return;
        }
        
        try {
            console.log(`${selectedFiles.length}개 이미지 합성 시작`);
            
            // 이미지들 로드
            const images = await Promise.all(
                selectedFiles.map(filePath => this.loadImageForCanvas(filePath))
            );
            
            // 그리드 크기 계산
            const { cols, rows } = calculateGridSize(images.length);
            
            // 캔버스 생성
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // 각 이미지의 크기 (정사각형으로 통일)
            const cellSize = 200;
            canvas.width = cols * cellSize;
            canvas.height = rows * cellSize;
            
            // 배경을 검은색으로 채우기
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // 이미지들을 그리드에 배치
            images.forEach((img, index) => {
                const row = Math.floor(index / cols);
                const col = index % cols;
                
                const x = col * cellSize;
                const y = row * cellSize;
                
                // 이미지를 셀 크기에 맞게 조정하여 그리기
                this.drawImageToFit(ctx, img, x, y, cellSize, cellSize);
            });
            
            // 캔버스를 Blob으로 변환하여 클립보드에 복사
            canvas.toBlob(async (blob) => {
                try {
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    console.log('합성된 이미지가 클립보드에 복사되었습니다.');
                    alert('합성된 이미지가 클립보드에 복사되었습니다.');
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);
                    alert('클립보드 복사에 실패했습니다.');
                }
            }, 'image/png');
            
        } catch (error) {
            console.error('이미지 합성 오류:', error);
            alert('이미지 합성에 실패했습니다.');
        }
    }
    
    /**
     * 캔버스용 이미지 로드
     * @param {string} filePath 파일 경로
     * @returns {Promise<HTMLImageElement>} 로드된 이미지
     */
    loadImageForCanvas(filePath) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            
            img.onload = () => resolve(img);
            img.onerror = (error) => reject(error);
            
            img.src = `/api/image?path=${encodeURIComponent(filePath)}`;
        });
    }
    
    /**
     * 이미지를 지정된 영역에 맞게 그리기 (비율 유지, 중앙 정렬)
     * @param {CanvasRenderingContext2D} ctx 캔버스 컨텍스트
     * @param {HTMLImageElement} img 이미지
     * @param {number} x X 좌표
     * @param {number} y Y 좌표
     * @param {number} width 너비
     * @param {number} height 높이
     */
    drawImageToFit(ctx, img, x, y, width, height) {
        const imgAspect = img.width / img.height;
        const targetAspect = width / height;
        
        let drawWidth, drawHeight, drawX, drawY;
        
        if (imgAspect > targetAspect) {
            // 이미지가 더 넓음 - 너비를 맞춤
            drawWidth = width;
            drawHeight = width / imgAspect;
            drawX = x;
            drawY = y + (height - drawHeight) / 2;
        } else {
            // 이미지가 더 높음 - 높이를 맞춤
            drawHeight = height;
            drawWidth = height * imgAspect;
            drawX = x + (width - drawWidth) / 2;
            drawY = y;
        }
        
        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    }
    
    /**
     * 선택된 파일 리스트를 클립보드에 복사
     */
    async copyFileList() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('복사할 파일을 선택해주세요.');
            return;
        }
        
        const fileList = selectedFiles.join('\n');
        const success = await copyToClipboard(fileList);
        
        if (success) {
            console.log('파일 리스트가 클립보드에 복사되었습니다.');
            alert(`${selectedFiles.length}개 파일 경로가 클립보드에 복사되었습니다.`);
        } else {
            alert('클립보드 복사에 실패했습니다.');
        }
    }
    
    /**
     * 선택된 파일 리스트를 테이블 형태로 클립보드에 복사
     */
    async copyFileListAsTable() {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length === 0) {
            alert('복사할 파일을 선택해주세요.');
            return;
        }
        
        // 테이블 데이터 생성
        const tableData = selectedFiles.map(filePath => {
            const folder = extractFolderName(filePath);
            const fileName = extractFileName(filePath);
            const nameParts = splitFileName(fileName, 5);
            
            return {
                folder: folder,
                part1: nameParts[0],
                part2: nameParts[1],
                part3: nameParts[2],
                part4: nameParts[3],
                part5: nameParts[4]
            };
        });
        
        // TSV 형식으로 변환
        const headers = ['Folder', 'Name_Part1', 'Name_Part2', 'Name_Part3', 'Name_Part4', 'Name_Part5'];
        let tableText = headers.join('\t') + '\n';
        
        tableData.forEach(row => {
            const values = [row.folder, row.part1, row.part2, row.part3, row.part4, row.part5];
            tableText += values.join('\t') + '\n';
        });
        
        const success = await copyToClipboard(tableText);
        
        if (success) {
            console.log('파일 리스트 테이블이 클립보드에 복사되었습니다.');
            alert(`${selectedFiles.length}개 파일 정보가 테이블 형태로 클립보드에 복사되었습니다.`);
        } else {
            alert('클립보드 복사에 실패했습니다.');
        }
    }
    
    /**
     * 현재 선택된 파일들 가져오기
     * @returns {Array<string>} 선택된 파일 경로들
     */
    getSelectedFiles() {
        if (!this.viewer.gridSelectedIdxs || this.viewer.gridSelectedIdxs.length === 0) {
            return [];
        }
        
        return this.viewer.gridSelectedIdxs
            .map(idx => this.viewer.selectedImages[idx])
            .filter(Boolean);
    }
}
