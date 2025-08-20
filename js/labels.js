/**
 * 라벨 및 클래스 관리 기능들
 * 클래스 생성/삭제, 라벨 추가/제거, Label Explorer 관리
 */

import { setButtonLoading, debounce } from './utils.js';

/**
 * 라벨 매니저 클래스
 */
export class LabelManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.classes = [];
        this.labelSelection = {
            selected: [],
            selectedClasses: []
        };
        
        // 디바운싱된 새로고침 함수
        this.debouncedRefresh = debounce(() => this.refreshAll(), 300);
        
        this.initElements();
        this.bindEvents();
    }
    
    /**
     * DOM 요소 초기화
     */
    initElements() {
        this.elements = {
            newClassInput: document.getElementById('new-class-input'),
            addClassBtn: document.getElementById('add-class-btn'),
            deleteClassBtn: document.getElementById('delete-class-btn'),
            classList: document.getElementById('class-list'),
            labelStatus: document.getElementById('label-status'),
            classImagesSection: document.getElementById('class-images-section'),
            classImagesTitle: document.getElementById('class-images-title'),
            classImagesList: document.getElementById('class-images-list'),
            labelExplorerList: document.getElementById('label-explorer-list'),
            batchLabelBtn: document.getElementById('label-explorer-batch-label-btn'),
            batchDeleteBtn: document.getElementById('label-explorer-batch-delete-btn')
        };
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        // 클래스 추가 버튼
        if (this.elements.addClassBtn) {
            this.elements.addClassBtn.addEventListener('click', () => this.addClass());
        }
        
        // 클래스 삭제 버튼
        if (this.elements.deleteClassBtn) {
            this.elements.deleteClassBtn.addEventListener('click', () => this.deleteSelectedClasses());
        }
        
        // 새 클래스 입력 필드에서 Enter 키
        if (this.elements.newClassInput) {
            this.elements.newClassInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addClass();
                }
            });
        }
        
        // 배치 라벨 추가 버튼
        if (this.elements.batchLabelBtn) {
            this.elements.batchLabelBtn.addEventListener('click', () => this.openAddLabelModal());
        }
        
        // 배치 라벨 삭제 버튼
        if (this.elements.batchDeleteBtn) {
            this.elements.batchDeleteBtn.addEventListener('click', () => this.deleteSelectedLabels());
        }
    }
    
    /**
     * 새 클래스 추가
     */
    async addClass() {
        const input = this.elements.newClassInput;
        const button = this.elements.addClassBtn;
        
        if (!input || !button) return;
        
        const className = input.value.trim();
        if (!className) {
            alert('클래스 이름을 입력해주세요.');
            return;
        }
        
        // 버튼 로딩 상태 설정
        const originalText = button.textContent;
        setButtonLoading(button, true, originalText, '추가 중...');
        
        try {
            const response = await fetch('/api/classes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: className })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || '클래스 생성에 실패했습니다.');
            }
            
            const result = await response.json();
            console.log('클래스 추가 성공:', result);
            
            // 입력 필드 초기화
            input.value = '';
            
            // UI 새로고침
            await this.refreshAll();
            
            alert(`클래스 "${className}"이 성공적으로 추가되었습니다.`);
            
        } catch (error) {
            console.error('클래스 추가 오류:', error);
            alert(`클래스 추가 실패: ${error.message}`);
        } finally {
            // 버튼 로딩 상태 해제
            setButtonLoading(button, false, originalText);
        }
    }
    
    /**
     * 선택된 클래스들 삭제
     */
    async deleteSelectedClasses() {
        const selectedClasses = this.getSelectedClasses();
        if (selectedClasses.length === 0) {
            alert('삭제할 클래스를 선택해주세요.');
            return;
        }
        
        const classNames = selectedClasses.map(cls => cls.name).join(', ');
        if (!confirm(`선택된 클래스들을 삭제하시겠습니까?\n\n${classNames}\n\n⚠️ 해당 클래스의 모든 라벨도 함께 삭제됩니다.`)) {
            return;
        }
        
        const button = this.elements.deleteClassBtn;
        const originalText = button?.textContent || '';
        
        if (button) {
            setButtonLoading(button, true, originalText, '삭제 중...');
        }
        
        try {
            const deletePromises = selectedClasses.map(cls =>
                fetch(`/api/classes/${encodeURIComponent(cls.name)}`, {
                    method: 'DELETE'
                })
            );
            
            const responses = await Promise.all(deletePromises);
            const errors = [];
            
            for (let i = 0; i < responses.length; i++) {
                if (!responses[i].ok) {
                    const errorData = await responses[i].json();
                    errors.push(`${selectedClasses[i].name}: ${errorData.error}`);
                }
            }
            
            if (errors.length > 0) {
                throw new Error(`일부 클래스 삭제 실패:\n${errors.join('\n')}`);
            }
            
            console.log(`${selectedClasses.length}개 클래스 삭제 완료`);
            
            // UI 새로고침
            await this.refreshAll();
            
            alert(`${selectedClasses.length}개 클래스가 성공적으로 삭제되었습니다.`);
            
        } catch (error) {
            console.error('클래스 삭제 오류:', error);
            alert(`클래스 삭제 실패: ${error.message}`);
        } finally {
            if (button) {
                setButtonLoading(button, false, originalText);
            }
        }
    }
    
    /**
     * 클래스 목록 새로고침
     */
    async refreshClassList() {
        try {
            const response = await fetch('/api/classes');
            if (!response.ok) {
                throw new Error('클래스 목록 조회 실패');
            }
            
            const data = await response.json();
            this.classes = data.classes || [];
            
            this.renderClassList();
            
        } catch (error) {
            console.error('클래스 목록 새로고침 오류:', error);
            if (this.elements.classList) {
                this.elements.classList.innerHTML = '<p style="color: #f00;">클래스 목록을 불러올 수 없습니다.</p>';
            }
        }
    }
    
    /**
     * 클래스 목록 렌더링
     */
    renderClassList() {
        if (!this.elements.classList) return;
        
        if (this.classes.length === 0) {
            this.elements.classList.innerHTML = '<p style="color: #888;">클래스가 없습니다.</p>';
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        this.classes.forEach(cls => {
            const classButton = this.createClassButton(cls);
            fragment.appendChild(classButton);
        });
        
        this.elements.classList.innerHTML = '';
        this.elements.classList.appendChild(fragment);
    }
    
    /**
     * 클래스 버튼 생성
     * @param {Object} cls 클래스 정보
     * @returns {HTMLElement} 클래스 버튼 요소
     */
    createClassButton(cls) {
        const button = document.createElement('button');
        button.className = 'class-btn';
        button.textContent = cls.name;
        button.title = `${cls.name} (${cls.count || 0}개 라벨)`;
        button.dataset.className = cls.name;
        
        // 클릭 이벤트
        button.addEventListener('click', (e) => {
            if (e.ctrlKey) {
                this.toggleClassSelection(cls.name);
            } else {
                this.selectClass(cls.name);
            }
            this.updateClassButtonStates();
        });
        
        return button;
    }
    
    /**
     * 클래스 선택
     * @param {string} className 클래스명
     */
    selectClass(className) {
        // 기존 선택 해제
        this.labelSelection.selectedClasses = [className];
        this.showClassImages(className);
    }
    
    /**
     * 클래스 선택 토글
     * @param {string} className 클래스명
     */
    toggleClassSelection(className) {
        const index = this.labelSelection.selectedClasses.indexOf(className);
        if (index > -1) {
            this.labelSelection.selectedClasses.splice(index, 1);
        } else {
            this.labelSelection.selectedClasses.push(className);
        }
    }
    
    /**
     * 클래스 버튼 상태 업데이트
     */
    updateClassButtonStates() {
        if (!this.elements.classList) return;
        
        const buttons = this.elements.classList.querySelectorAll('.class-btn');
        buttons.forEach(button => {
            const className = button.dataset.className;
            const isSelected = this.labelSelection.selectedClasses.includes(className);
            button.classList.toggle('selected', isSelected);
        });
    }
    
    /**
     * 선택된 클래스의 이미지들 표시
     * @param {string} className 클래스명
     */
    async showClassImages(className) {
        if (!this.elements.classImagesSection || !this.elements.classImagesList) return;
        
        try {
            const response = await fetch(`/api/classes/${encodeURIComponent(className)}/images`);
            if (!response.ok) {
                throw new Error('클래스 이미지 조회 실패');
            }
            
            const data = await response.json();
            const images = data.images || [];
            
            // 제목 업데이트
            if (this.elements.classImagesTitle) {
                this.elements.classImagesTitle.textContent = `${className} (${images.length}개)`;
                this.elements.classImagesTitle.style.display = 'block';
            }
            
            // 이미지 목록 렌더링
            this.renderClassImages(images);
            
            this.elements.classImagesSection.style.display = 'block';
            
        } catch (error) {
            console.error('클래스 이미지 표시 오류:', error);
            if (this.elements.classImagesList) {
                this.elements.classImagesList.innerHTML = '<p style="color: #f00;">이미지를 불러올 수 없습니다.</p>';
            }
        }
    }
    
    /**
     * 클래스 이미지 목록 렌더링
     * @param {Array} images 이미지 배열
     */
    renderClassImages(images) {
        if (!this.elements.classImagesList) return;
        
        if (images.length === 0) {
            this.elements.classImagesList.innerHTML = '<p style="color: #888;">라벨된 이미지가 없습니다.</p>';
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        images.forEach(imagePath => {
            const imageItem = this.createClassImageItem(imagePath);
            fragment.appendChild(imageItem);
        });
        
        this.elements.classImagesList.innerHTML = '';
        this.elements.classImagesList.appendChild(fragment);
    }
    
    /**
     * 클래스 이미지 아이템 생성
     * @param {string} imagePath 이미지 경로
     * @returns {HTMLElement} 이미지 아이템 요소
     */
    createClassImageItem(imagePath) {
        const item = document.createElement('div');
        item.className = 'class-image-item';
        
        const img = document.createElement('img');
        img.src = `/api/thumbnail?path=${encodeURIComponent(imagePath)}`;
        img.alt = imagePath.split('/').pop();
        img.title = imagePath;
        
        const fileName = document.createElement('div');
        fileName.className = 'class-image-filename';
        fileName.textContent = imagePath.split('/').pop();
        
        item.appendChild(img);
        item.appendChild(fileName);
        
        // 클릭 시 해당 이미지 표시
        item.addEventListener('click', () => {
            this.viewer.loadImage(imagePath);
        });
        
        return item;
    }
    
    /**
     * Label Explorer 새로고침
     */
    async refreshLabelExplorer() {
        // 구현은 기존 main.js의 refreshLabelExplorer 로직을 여기로 이동
        // 복잡한 로직이므로 여기서는 스켈레톤만 제공
        console.log('Label Explorer 새로고침');
    }
    
    /**
     * Add Label 모달 열기
     */
    async openAddLabelModal() {
        const selectedImages = this.viewer.getSelectedImagesForModal();
        if (selectedImages.length === 0) {
            alert('라벨을 추가할 이미지를 선택해주세요.');
            return;
        }
        
        // 모달 표시 로직
        const modal = document.getElementById('add-label-modal');
        if (modal) {
            modal.style.display = 'block';
            await this.populateModalClassList();
            this.updateModalImageInfo(selectedImages);
        }
    }
    
    /**
     * 모달의 클래스 목록 채우기
     */
    async populateModalClassList() {
        const classSelect = document.getElementById('modal-class-select');
        if (!classSelect) return;
        
        // 기존 옵션 제거 (첫 번째 옵션 제외)
        while (classSelect.children.length > 1) {
            classSelect.removeChild(classSelect.lastChild);
        }
        
        // 클래스 목록 추가
        this.classes.forEach(cls => {
            const option = document.createElement('option');
            option.value = cls.name;
            option.textContent = cls.name;
            classSelect.appendChild(option);
        });
    }
    
    /**
     * 모달의 이미지 정보 업데이트
     * @param {Array<string>} selectedImages 선택된 이미지들
     */
    updateModalImageInfo(selectedImages) {
        const infoElement = document.getElementById('current-image-info');
        if (infoElement) {
            infoElement.textContent = `${selectedImages.length}개 이미지 선택됨`;
        }
    }
    
    /**
     * 선택된 라벨들 삭제
     */
    async deleteSelectedLabels() {
        if (this.labelSelection.selectedClasses.length === 0 && this.labelSelection.selected.length === 0) {
            alert('삭제할 라벨을 선택해주세요.');
            return;
        }
        
        // 삭제 로직 구현
        console.log('선택된 라벨 삭제:', this.labelSelection);
    }
    
    /**
     * 선택된 클래스들 반환
     * @returns {Array} 선택된 클래스 배열
     */
    getSelectedClasses() {
        return this.classes.filter(cls => 
            this.labelSelection.selectedClasses.includes(cls.name)
        );
    }
    
    /**
     * 모든 UI 새로고침
     */
    async refreshAll() {
        await Promise.all([
            this.refreshClassList(),
            this.refreshLabelExplorer()
        ]);
    }
    
    /**
     * 리소스 정리
     */
    cleanup() {
        this.labelSelection.selected = [];
        this.labelSelection.selectedClasses = [];
    }
}
